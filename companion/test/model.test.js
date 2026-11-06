import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, reduceEvent, disconnected } from '../menubar/model.js';
import { Preview, MultiPreview, currentPage, currentPages } from '../menubar/preview.js';

const task = (key, endedAt = 1) => ({ key, sessionId: key.split('/')[0], taskId: key.split('/')[1], createdAt: 'one',
  currentCommand: null, currentTab: { id: key, title: key }, lastCommand: { cmd: 'snapshot', endedAt } });
const initial = () => reduceEvent(emptyState(), { type: 'daemon.status', revision: 1, browser: 'connected',
  scopes: [task('a/one'), task('b/two', 2)], activeCount: 0, idleMs: 0 });

test('one session observes only its latest page, including across tasks', async () => {
  let state = initial(); const views = [], calls = [];
  const preview = new MultiPreview('/fixture.sock', () => state, view => views.push(view), async (_path, request) => {
    calls.push(request.params.tabId); return { result: { tabId: request.params.tabId, image: 'frame' } };
  });
  preview.visible = true; await preview.refresh();
  state.scopes.push(task('a/new-task', 100));
  await preview.refresh();
  assert.deepEqual(new Set(views.at(-1).pages.map(page => page.tab.id)), new Set(['a/new-task', 'b/two']));
  assert.equal(preview.entries.size, 2);
  assert.equal(calls.filter(id => id === 'a/one').length, 1, 'old session page is no longer captured');
  preview.hide();
});

test('multi-page previews capture independently, deduplicate tabs, and remove stale cards immediately', async () => {
  let state = initial(); const calls = [], views = [], releases = [];
  state.scopes.push({ ...task('duplicate/page'), currentTab: state.scopes[0].currentTab });
  assert.equal(currentPages(state).length, 2);
  const preview = new MultiPreview('/fixture.sock', () => state, view => views.push(view), async (_path, request) => {
    calls.push(request); return new Promise(resolve => releases.push(() => resolve({ result: { tabId: request.params.tabId, image: request.params.tabId } })));
  });
  await preview.refresh(); assert.equal(calls.length, 0);
  preview.visible = true;
  const pending = preview.refresh();
  assert.equal(calls.length, 2);
  assert.equal(views.at(-1).pages.length, 2);
  releases[1](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(views.at(-1).pages.filter(page => page.image).length, 1);
  state = disconnected(state); await preview.refresh();
  assert.deepEqual(views.at(-1).pages, [], 'disconnect clears even with a capture pending');
  releases[0](); await pending;
  assert.deepEqual(views.at(-1).pages, [], 'late frame cannot recreate a disconnected card');
  state = initial(); const reconnected = preview.refresh();
  const again = [...releases].slice(2); again.forEach(release => release());
  await reconnected;
  preview.hide();
});

test('preview follows the executing scope, then the most recently operated page', () => {
  let state = initial();
  assert.equal(currentPage(state).key, 'b/two');
  state = reduceEvent(state, { type: 'cmd.start', revision: 2, scope: 'a/one', cmd: 'fill', startedAt: 1000 });
  assert.equal(currentPage(state).key, 'a/one');
  assert.equal(currentPage(disconnected(state)), null);
  state = reduceEvent(disconnected(state), { type: 'daemon.status', revision: 0, browser: 'connected', scopes: [task('new/task')], activeCount: 0, idleMs: 0 });
  assert.equal(state.scopes.length, 1); assert.equal(currentPage(state).key, 'new/task');
});

test('hidden previews do not poll; stale screenshot responses cannot replace a newly selected page', async () => {
  let state = initial(), release; const calls = [], views = [];
  const preview = new Preview('/fixture.sock', () => state, (view) => views.push(view), async (_path, request) => {
    calls.push(request); return new Promise((resolve) => { release = resolve; });
  });
  await preview.refresh(); assert.equal(calls.length, 0);
  preview.visible = true;
  const pending = preview.refresh();
  await preview.refresh(); assert.equal(calls.length, 1);
  assert.equal(calls[0].method, '_preview'); assert.equal(calls[0].scope.sessionId, 'b');
  state.scopes[0].currentCommand = { cmd: 'click', startedAt: 100 };
  release({ result: { image: 'data:image/jpeg;base64,old', tabId: 'b/two' } });
  await pending;
  assert.ok(views.every((view) => !view.image));
  preview.hide();
});

test('busy preview keeps only the last image of the same tab; disconnect clears it', async () => {
  let state = initial(), views = [];
  const preview = new Preview('/fixture.sock', () => state, (view) => views.push(view), async () => ({ error: { code: -32003 } }));
  preview.visible = true; preview.frame = { tabId: 'b/two', image: 'data:image/jpeg;base64,frame' };
  await preview.refresh();
  assert.equal(views.at(-1).status, 'busy'); assert.ok(views.at(-1).image);
  state = disconnected(state); await preview.refresh();
  assert.equal(views.at(-1).image, null);
  preview.hide();
});

test('visible preview captures once per completion, never while idle or executing', async () => {
  let state = initial(); const calls = [], views = [];
  const preview = new Preview('/fixture.sock', () => state, view => views.push(view), async (_path, request) => {
    calls.push(request); return { result: { image: 'data:image/jpeg;base64,frame', tabId: 'b/two' } };
  });
  preview.visible = true;
  await preview.refresh();
  assert.equal(calls.length, 1);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(calls.length, 1, 'no screenshot polling timer remains');
  state = reduceEvent(state, { type: 'daemon.heartbeat', revision: 2, idleMs: 1000, idleTimeoutMs: 30_000 });
  await preview.refresh();
  state = reduceEvent(state, { type: 'tab.change', revision: 3, scope: 'b/two', tabId: 'b/two', title: 'new title' });
  await preview.refresh();
  assert.equal(calls.length, 1, 'heartbeat and metadata updates reuse the frame');
  state = reduceEvent(state, { type: 'cmd.start', revision: 4, scope: 'b/two', cmd: 'fill', startedAt: 1000 });
  await preview.refresh();
  assert.equal(calls.length, 1);
  assert.equal(views.at(-1).status, 'busy');
  state = reduceEvent(state, { type: 'cmd.end', revision: 5, scope: 'b/two', cmd: 'fill', endedAt: 2000, ts: 2001, ok: true });
  await preview.refresh();
  assert.equal(calls.length, 2);
  assert.equal(views.at(-1).status, 'ready');
  // A full state replay must use the exact same completion timestamp.
  state = reduceEvent(state, { ...state, type: 'daemon.status', revision: 6, idleMs: 0 });
  await preview.refresh();
  assert.equal(calls.length, 2);
  preview.hide();
});
