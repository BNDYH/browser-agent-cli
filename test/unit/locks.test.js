import test from 'node:test';
import assert from 'node:assert/strict';
import { TabLocks } from '../../src/core/locks.js';

test('tab lock is exclusive and releasable by owner', () => {
  const locks = new TabLocks(30_000);
  const token = locks.acquire('1', 'a/default');
  assert.throws(() => locks.acquire('1', 'b/default'), (error) => error.code === -32003);
  locks.release('1', token);
  assert.doesNotThrow(() => locks.acquire('1', 'b/default'));
});

test('expired tab lock can be acquired', () => {
  const locks = new TabLocks(0);
  locks.acquire('1', 'a/default');
  assert.doesNotThrow(() => locks.acquire('1', 'b/default'));
});

test('stale owner cannot release a replacement lease', () => {
  const locks = new TabLocks(1000);
  const oldToken = locks.acquire('1', 'a/default');
  locks.locks.get('1').expiresAt = Date.now() - 1;
  const newToken = locks.acquire('1', 'a/default');
  locks.release('1', oldToken);
  assert.throws(() => locks.acquire('1', 'b/default'), (error) => error.code === -32003);
  locks.release('1', newToken);
  assert.doesNotThrow(() => locks.acquire('1', 'b/default'));
});

test('same-scope overlapping operations are not reentrant', () => {
  const locks = new TabLocks();
  locks.acquire('1', 'a/default');
  assert.throws(() => locks.acquire('1', 'a/default'), (error) => error.code === -32003);
});
