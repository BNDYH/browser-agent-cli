import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserAgentApi } from '../../src/api.js';
import { getConfig } from '../../src/config.js';
import { parseArgv, toRpcCommand } from '../../src/cli/parser.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-reuse-'));
  const events = [], navigations = [], closed = [];
  const api = new BrowserAgentApi({ ...getConfig(), stateDir: root, statePath: path.join(root, 'state.json'), auditPath: path.join(root, 'audit.log') }, event => events.push(event));
  api.connection = { connected: true, requireContext: () => ({}) };
  api.tabs.sync = async () => {};
  api.tabs.mark = api.tabs.unmark = async () => {};
  api.tabs.describe = async (id, page) => ({ id, url: page.url(), title: 'Fixture' });
  const add = (id, url) => {
    const page = { isClosed: () => closed.includes(id), url: () => url, title: async () => 'Fixture',
      goto: async value => { navigations.push(value); url = value; }, close: async () => closed.push(id) };
    api.tabs.pages.set(id, page); return page;
  };
  api.tabs.new = async scope => {
    const id = `new-${api.tabs.pages.size}`;
    const page = add(id, 'about:blank'); scope.currentTabId = id; scope.ownedTabs.add(id); return { id, page };
  };
  return { api, events, add, navigations, closed };
}
const a = { sessionId: 'a', taskId: 'task' }, b = { sessionId: 'b', taskId: 'task' };

test('open reuses idle pages across sessions without navigating; finish drops only the preview target', async () => {
  const { api, add, events, navigations, closed } = fixture();
  add('existing', 'https://example.test/?q=1#form');
  const owner = api.scopes.get(a); owner.currentTabId = 'existing'; owner.ownedTabs.add('existing');
  const result = await api.dispatch('open', { url: 'https://example.test/?q=1#form' }, b);
  assert.equal(result.tab.id, 'existing'); assert.deepEqual(navigations, []);
  await api.dispatch('kill', {}, a);
  assert.deepEqual(closed, [], 'owner cleanup preserves a borrowed page');
  await api.dispatch('finish', {}, b);
  assert.equal(api.scopes.peek(b).currentTabId, null);
  assert.equal(api.tabs.pages.size, 1);
  assert.ok(events.some(event => event.reason === 'finish' && event.tabId === null));
  assert.equal((await api.dispatch('open', { url: 'https://example.test/?q=1#form' }, a)).tab.id, 'existing');
});

test('busy or different URLs get separate tabs; explicit new creates a page', async () => {
  const { api, add, navigations } = fixture();
  add('busy', 'https://example.test/?q=1#form');
  api.scopes.get(a).currentTabId = 'busy';
  api.busyScopes.add('a/task');
  const token = api.locks.acquire('busy', 'a/task');
  const result = await api.dispatch('open', { url: 'https://example.test/?q=1#form' }, b);
  assert.notEqual(result.tab.id, 'busy');
  assert.equal(navigations.length, 1);
  api.locks.release('busy', token); api.busyScopes.delete('a/task');
  const different = await api.dispatch('open', { url: 'https://example.test/?q=2#form' }, b);
  assert.notEqual(different.tab.id, result.tab.id);
  assert.equal(navigations.at(-1), 'https://example.test/?q=2#form');
  const forced = await api.dispatch('new', { url: different.tab.url }, b);
  assert.notEqual(forced.tab.id, different.tab.id);
});

test('opening a different URL reuses a matching tab without navigating the previous tab', async () => {
  const { api, add } = fixture();
  add('current', 'https://example.test/old'); add('match', 'https://example.test/new');
  api.scopes.get(b).currentTabId = 'current';
  const result = await api.dispatch('open', { url: 'https://example.test/new' }, b);
  assert.equal(result.tab.id, 'match');
  assert.equal(api.tabs.pages.get('current').url(), 'https://example.test/old');
  assert.equal(result.tab.url, 'https://example.test/new');
});

test('open/finish CLI validates inputs and timeout', () => {
  assert.deepEqual(toRpcCommand(parseArgv(['finish'])), ['finish', {}]);
  assert.deepEqual(toRpcCommand(parseArgv(['open', 'https://example.test/', '--timeout', '500'])), ['open', { url: 'https://example.test/', timeout: 500 }]);
  assert.throws(() => toRpcCommand(parseArgv(['open'])));
  assert.throws(() => toRpcCommand(parseArgv(['finish', 'extra'])));
});
