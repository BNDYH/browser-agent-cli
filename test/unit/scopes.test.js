import test from 'node:test';
import assert from 'node:assert/strict';
import { ScopeStore, scopeKey } from '../../src/core/scopes.js';

test('rejects ambiguous scope keys and path traversal', () => {
  assert.throws(() => scopeKey({ sessionId: 'a/b', taskId: 'c' }));
  assert.throws(() => scopeKey({ sessionId: 'a', taskId: '../b' }));
  assert.throws(() => scopeKey({ sessionId: '', taskId: 'a' }));
});

test('persisted scopes retain targets and ownership but not request bodies', () => {
  const store = new ScopeStore();
  const identity = { sessionId: 'a', taskId: 'one' };
  const state = store.get(identity);
  state.currentTabId = 'target-id';
  state.ownedTabs.add('target-id');
  state.overlayOn = false;
  state.reqCache.push({ postData: 'secret' });
  const persisted = JSON.stringify(store.serialize());
  assert.doesNotMatch(persisted, /secret/);
  const restored = new ScopeStore();
  restored.restore(JSON.parse(persisted));
  assert.equal(restored.peek(identity).currentTabId, 'target-id');
  assert.equal(restored.peek(identity).overlayOn, false);
  assert.ok(restored.peek(identity).ownedTabs.has('target-id'));
  assert.deepEqual(restored.peek(identity).reqCache, []);
});
