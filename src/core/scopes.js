import { DtError } from '../errors.js';

export function validateScope(scope) {
  if (!scope || ![scope.sessionId, scope.taskId].every((value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value))) {
    throw new DtError('session and task must contain 1–128 letters, digits, dots, underscores or hyphens', -32602);
  }
}

export function scopeKey(scope) {
  validateScope(scope);
  return `${scope.sessionId}/${scope.taskId}`;
}

export class ScopeStore {
  constructor() {
    this.scopes = new Map();
  }

  get(scope) {
    const key = scopeKey(scope);
    let state = this.scopes.get(key);
    if (!state) {
      const now = new Date().toISOString();
      state = {
        key,
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        currentTabId: null,
        ownedTabs: new Set(),
        reqCache: [],
        overlayOn: true,
        createdAt: now,
        lastActiveAt: now,
      };
      this.scopes.set(key, state);
    }
    state.lastActiveAt = new Date().toISOString();
    return state;
  }

  peek(scope) {
    return this.scopes.get(scopeKey(scope));
  }

  deleteScope(scope) {
    return this.scopes.delete(scopeKey(scope));
  }

  bySession(sessionId) {
    return [...this.scopes.values()].filter((state) => state.sessionId === sessionId);
  }

  serialize() {
    return [...this.scopes.values()].map(({ reqCache, ownedTabs, ...state }) => ({ ...state, ownedTabs: [...ownedTabs] }));
  }

  restore(states = []) {
    for (const saved of states) {
      try {
        const key = scopeKey(saved);
        this.scopes.set(key, { ...saved, key, ownedTabs: new Set(saved.ownedTabs || []), reqCache: [] });
      } catch { /* Ignore incompatible persisted scopes. */ }
    }
  }
}
