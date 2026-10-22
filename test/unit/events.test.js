import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserAgentApi } from '../../src/api.js';
import { getConfig } from '../../src/config.js';
import { eventUrl } from '../../src/events.js';
import { formatError } from '../../src/errors.js';

test('event URLs remove credentials and non-web payloads', () => {
  assert.equal(eventUrl('https://user:secret@example.com/a?token=secret#secret'), 'https://example.com/a');
  assert.equal(eventUrl('data:text/html,secret'), 'data:');
  assert.equal(eventUrl('file:///secret'), 'file:');
});

test('runtime snapshot includes safe in-flight state; closing shared tab clears every scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-events-'));
  const config = { ...getConfig(), stateDir: root, shotsDir: path.join(root, 'shots'), statePath: path.join(root, 'state.json'), auditPath: path.join(root, 'audit.log') };
  const events = [];
  const api = new BrowserAgentApi(config, (event) => events.push(event));
  api.connection = { connected: true };
  for (const taskId of ['a', 'b']) {
    const scope = api.scopes.get({ sessionId: 'test', taskId });
    scope.currentTabId = 'target'; scope.ownedTabs.add('target');
  }
  const scope = api.scopes.peek({ sessionId: 'test', taskId: 'a' });
  scope.reqCache.push({ n: 1, url: 'https://example.com/?secret', requestHeaders: { cookie: 'secret' } });
  api.tabs.metadata.set('target', { id: 'target', title: 'Title', url: 'https://example.com/?secret' });
  api.commands.set(scope.key, { current: { cmd: 'waitms', startedAt: 123 } });
  const before = api.lastActiveAt;
  const snapshot = api.eventSnapshot();
  assert.equal(snapshot.scopes[0].currentCommand.cmd, 'waitms');
  assert.equal(snapshot.scopes[0].requestCount, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/);
  assert.equal(api.lastActiveAt, before);
  api.tabChanged({ id: 'target', reason: 'closed' });
  assert.equal(events.filter((event) => event.type === 'tab.change' && event.tabId === null).length, 2);
  for (const state of api.scopes.scopes.values()) {
    assert.equal(state.currentTabId, null); assert.equal(state.ownedTabs.size, 0);
  }
});

test('text and JSON errors preserve context and original script stack', () => {
  const error = { message: 'failed', code: -32000, data: { selector: '#missing', url: 'http://fixture/', title: 'Fixture', stack: 'Error: failed\n at /tmp/script.mjs:3:9' } };
  const text = formatError(error);
  assert.match(text, /selector: #missing/); assert.match(text, /url: http:\/\/fixture\//);
  assert.match(text, /script.mjs:3:9/);
  assert.deepEqual(JSON.parse(formatError(error, true)).error, error);
});

test('thumbnail observes without activity; user commands wait for it and previews stop after idle deadline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-preview-'));
  const config = { ...getConfig(), stateDir: root, shotsDir: path.join(root, 'shots'), statePath: path.join(root, 'state.json'), auditPath: path.join(root, 'audit.log') };
  const api = new BrowserAgentApi(config);
  const identity = { sessionId: 'preview', taskId: 'test' };
  const scope = api.scopes.get(identity); scope.currentTabId = 'target';
  let finishCapture, startedCapture;
  const started = new Promise((resolve) => { startedCapture = resolve; });
  const context = { newCDPSession: async () => ({ detach: async () => {}, send: async (method, params) => {
    assert.equal(method, 'Page.captureScreenshot');
    assert.equal(params.clip, undefined, 'thumbnail capture must not scale the browser viewport');
    assert.equal(params.captureBeyondViewport, false);
    startedCapture(); return new Promise((resolve) => { finishCapture = () => resolve({ data: 'jpeg' }); });
  } }) };
  const page = { context: () => context, isClosed: () => false, title: async () => 'Fixture', url: () => 'https://fixture/' };
  api.connection = { connected: true, requireContext: () => context };
  api.tabs.pages.set('target', page);
  api.tabs.current = async () => page; api.tabs.mark = async () => {};
  const before = api.lastActiveAt;
  const capture = api.dispatch('_preview', { tabId: 'target', createdAt: scope.createdAt }, identity);
  await started;
  assert.equal(api.lastActiveAt, before);
  let completed = false;
  const command = api.dispatch('title', {}, identity).then((result) => { completed = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  finishCapture(); await capture;
  assert.equal((await command).title, 'Fixture');
  assert.deepEqual(fs.readFileSync(config.auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line).command), ['title']);
  api.lastActiveAt = Date.now() - config.idleTimeoutMs - 1;
  await assert.rejects(api.dispatch('_preview', { tabId: 'target', createdAt: scope.createdAt }, identity), (error) => error.code === -32002);
  assert.equal(api.activeCount, 0);
});
