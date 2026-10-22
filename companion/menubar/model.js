export function emptyState() {
  return { connected: false, stale: false, scopes: [], activeCount: 0, idleSince: Date.now(), idleTimeoutMs: 0 };
}

export function reduceEvent(previous, event, now = Date.now()) {
  if (event.type === 'daemon.status') {
    return { ...event, connected: true, stale: false, idleSince: now - event.idleMs };
  }
  if (!previous.connected || event.revision <= previous.revision) return previous;
  const state = structuredClone(previous);
  state.revision = event.revision;
  let scope = state.scopes.find((item) => item.key === event.scope);
  if (event.type === 'scope.create') {
    if (!scope) state.scopes.push(event.state);
  } else if (event.type === 'scope.destroy') {
    state.scopes = state.scopes.filter((item) => item.key !== event.scope);
  } else if (event.type === 'daemon.heartbeat') {
    state.idleSince = now - event.idleMs;
    state.idleTimeoutMs = event.idleTimeoutMs;
  } else if (scope) {
    if (event.type === 'cmd.start') {
      scope.currentCommand = { cmd: event.cmd, startedAt: event.startedAt };
      state.idleSince = now;
    } else if (event.type === 'cmd.end') {
      scope.currentCommand = null;
      scope.lastCommand = { cmd: event.cmd, ok: event.ok, ms: event.ms, endedAt: event.endedAt ?? event.ts };
      state.idleSince = now;
    } else if (event.type === 'tab.change') {
      scope.currentTab = event.tabId ? { id: event.tabId, title: event.title, url: event.url } : null;
    }
  }
  state.activeCount = state.scopes.filter((item) => item.currentCommand).length;
  return state;
}

export function disconnected(state) {
  return { ...state, connected: false, stale: state.scopes.length > 0 };
}
