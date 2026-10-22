import { randomUUID } from 'node:crypto';
import { rpcCall } from '../../src/daemon/rpc.js';

export function currentPage(state) {
  if (!state.connected || state.browser !== 'connected') return null;
  return state.scopes.filter((scope) => scope.currentTab).sort((a, b) => {
    const rank = (scope) => scope.currentCommand ? Number.MAX_SAFE_INTEGER / 2 + scope.currentCommand.startedAt
      : scope.lastCommand?.endedAt || Date.parse(scope.lastActiveAt || scope.createdAt) || 0;
    return rank(b) - rank(a);
  })[0] || null;
}

function frameKey(scope) {
  return scope ? JSON.stringify([scope.key, scope.createdAt, scope.currentTab.id,
    scope.lastCommand?.cmd, scope.lastCommand?.endedAt]) : null;
}

export class Preview {
  constructor(socketPath, readState, publish, call = rpcCall) {
    Object.assign(this, { socketPath, readState, publish, call, visible: false, pending: false });
    this.frame = null; this.lastAttempt = 0; this.lastTarget = null;
    this.attemptedKey = null; this.generation = 0; this.dirty = false;
  }
  async refresh() {
    if (!this.visible) return;
    if (this.pending) { this.dirty = true; return; }
    clearTimeout(this.timer);
    const scope = currentPage(this.readState());
    const id = scope?.currentTab.id;
    if (!id) {
      this.frame = null; this.attemptedKey = null;
      this.publish({ status: 'unavailable', image: null }); return;
    }
    if (this.frame?.tabId !== id) this.frame = null;
    // Commands own the page while running. Only capture their final state.
    if (scope.currentCommand) {
      this.publish({ status: 'busy', tab: scope.currentTab, ...this.frame }); return;
    }
    const key = frameKey(scope);
    if (this.attemptedKey === key) {
      // Metadata/heartbeat events may update the title, but never poll the page.
      if (this.frame) this.publish({ status: 'ready', tab: scope.currentTab, ...this.frame });
      return;
    }
    const delay = 1200 - (Date.now() - this.lastAttempt);
    if (this.lastTarget === id && delay > 0) {
      this.timer = setTimeout(() => void this.refresh(), delay); return;
    }
    this.lastTarget = id; this.lastAttempt = Date.now(); this.attemptedKey = key;
    this.publish({ status: 'loading', tab: scope.currentTab, ...this.frame });
    this.pending = true;
    const generation = this.generation;
    try {
      const reply = await this.call(this.socketPath, { jsonrpc: '2.0', id: randomUUID(), method: '_preview',
        params: { tabId: id, createdAt: scope.createdAt }, scope: { sessionId: scope.sessionId, taskId: scope.taskId } }, 6000);
      const selected = currentPage(this.readState());
      if (!this.visible || generation !== this.generation || frameKey(selected) !== key || selected.currentCommand) return;
      if (reply.error) {
        this.publish({ status: reply.error.code === -32003 ? 'busy' : 'unavailable', tab: selected.currentTab, ...this.frame });
      } else {
        this.frame = reply.result;
        this.publish({ status: 'ready', tab: selected.currentTab, ...this.frame });
      }
    } catch {
      if (this.visible && generation === this.generation) this.publish({ status: 'unavailable', image: null });
    } finally {
      this.pending = false;
      if (this.dirty) { this.dirty = false; void this.refresh(); }
    }
  }
  show() {
    this.visible = true; this.generation++; this.attemptedKey = null;
    void this.refresh();
  }
  hide() {
    this.visible = false; this.generation++; clearTimeout(this.timer);
    this.frame = null; this.lastAttempt = 0; this.attemptedKey = null;
  }
}
