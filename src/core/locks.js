import { DtError } from '../errors.js';
import { randomUUID } from 'node:crypto';

export class TabLocks {
  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
    this.locks = new Map();
  }

  acquire(tabId, scopeKey) {
    const now = Date.now();
    const held = this.locks.get(tabId);
    if (held && held.expiresAt > now) {
      throw new DtError(`tab ${tabId} is locked by ${held.ownerScope}`, -32003, {
        tabId,
        ownerScope: held.ownerScope,
        expiresAt: held.expiresAt,
      });
    }
    const token = randomUUID();
    this.locks.set(tabId, { token, ownerScope: scopeKey, acquiredAt: now, expiresAt: now + this.ttlMs });
    return token;
  }

  renew(tabId, token) {
    const held = this.locks.get(tabId);
    if (held?.token === token) held.expiresAt = Date.now() + this.ttlMs;
  }

  release(tabId, token) {
    if (this.locks.get(tabId)?.token === token) this.locks.delete(tabId);
  }

  warning(tabId, scopeKey) {
    const held = this.locks.get(tabId);
    if (!held || held.expiresAt <= Date.now() || held.ownerScope === scopeKey) return undefined;
    return { ownerScope: held.ownerScope, expiresAt: held.expiresAt };
  }
}
