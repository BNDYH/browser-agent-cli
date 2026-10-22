import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { audit } from './audit.js';
import { DtError } from './errors.js';
import { readState, writeState } from './session.js';
import { validateCommand } from './validation.js';
import { Connection } from './core/connection.js';
import { ScopeStore, scopeKey } from './core/scopes.js';
import { TabLocks } from './core/locks.js';
import { NetworkCapture, filterRequests, redactHeaders, toHar, queryParams, requestSummary } from './core/network.js';
import { TabManager } from './core/tabManager.js';
import { navigation, act } from './core/actions.js';
import { cookies, evaluate, listElements, localStorage } from './core/inject.js';
import { takeSnapshot } from './core/snapshot.js';
import { ExtensionBridge } from './extension/bridge.js';
import { ExtensionConnection } from './extension/connection.js';
import { eventUrl, eventRequest } from './events.js';

const LIFECYCLE = new Set(['launch', 'connect', 'disconnect', 'kill']);
const CACHE = new Set(['reqs', 'req', 'res', 'har', 'reqclear']);

export class BrowserAgentApi {
  constructor(config, onEvent = () => {}) {
    this.config = config;
    this.revision = 0;
    this.emit = (event) => onEvent({ ...event, revision: ++this.revision, ts: Date.now() });
    this.commands = new Map();
    this.scopes = new ScopeStore();
    this.extensionBridge = new ExtensionBridge();
    this.cdpConnection = new Connection(config, () => {
      if (this.backend === 'cdp') { this.tabs.reset(); this.emit(this.eventSnapshot()); }
    });
    this.extensionConnection = new ExtensionConnection(config, this.extensionBridge);
    this.backend = readState(config).backend === 'extension' ? 'extension' : 'cdp';
    this.connection = this.backend === 'extension' ? this.extensionConnection : this.cdpConnection;
    this.network = new NetworkCapture(this.scopes, config.requestCacheSize, (event) => {
      // Event feeds carry summaries, not request credentials or query parameters.
      const state = this.scopes.scopes.get(event.scope);
      if (state) this.emit({ type: event.type, scope: event.scope, phase: event.phase,
        ...eventRequest(event), requestCount: state.reqCache.length });
    });
    this.tabs = new TabManager(this.connection, this.network, (tab) => this.tabChanged(tab));
    this.locks = new TabLocks(config.lockTtlMs);
    this.startedAt = Date.now();
    this.lastActiveAt = Date.now();
    this.busyScopes = new Set();
    this.previewCount = 0;
    this.previews = new Map();
    this.lifecycleBusy = false;
    this.stopping = false;
    this.extensionBridge.on('disconnected', () => {
      if (this.backend === 'extension') { this.tabs.reset(); this.emit(this.eventSnapshot()); }
    });
  }

  get activeCount() { return this.busyScopes.size + this.previewCount; }

  async initialize() {
    const saved = readState(this.config);
    this.scopes.restore(saved.scopes);
    if (await this.connection.restore()) {
      if (saved.browserId !== this.connection.browserId) this.scopes.scopes.clear();
      await this.tabs.sync();
      for (const scope of this.scopes.scopes.values()) {
        const page = this.tabs.pages.get(scope.currentTabId);
        if (page) await this.tabs.unmark(page);
      }
    }
  }

  persist() {
    writeState({ ...readState(this.config), scopes: this.scopes.serialize() }, this.config);
  }

  scopeSnapshot(scope) {
    const tab = this.connection.connected && this.tabs.metadata.get(scope.currentTabId);
    const runtime = this.commands.get(scope.key) || {};
    return { key: scope.key, sessionId: scope.sessionId, taskId: scope.taskId, createdAt: scope.createdAt,
      lastActiveAt: scope.lastActiveAt, currentCommand: runtime.current || null,
      lastCommand: runtime.last || null, currentTab: tab ? { ...tab, url: eventUrl(tab.url) } : null,
      requestCount: scope.reqCache.length };
  }

  eventSnapshot() {
    return { type: 'daemon.status', revision: this.revision, ts: Date.now(),
      daemon: this.stopping ? 'stopping' : 'running', browser: this.connection.connected ? 'connected' : 'disconnected',
      backend: this.backend, idleMs: Date.now() - this.lastActiveAt, idleTimeoutMs: this.config.idleTimeoutMs,
      activeCount: this.busyScopes.size, scopes: [...this.scopes.scopes.values()].map((scope) => this.scopeSnapshot(scope)) };
  }

  tabChanged(tab) {
    for (const scope of this.scopes.scopes.values()) {
      const current = scope.currentTabId === tab.id;
      if (tab.reason === 'closed') {
        scope.ownedTabs.delete(tab.id);
        if (current) scope.currentTabId = null;
      }
      if (current) this.emit({ type: 'tab.change', scope: scope.key,
        tabId: tab.reason === 'closed' ? null : tab.id,
        title: tab.title || '', url: eventUrl(tab.url), reason: tab.reason });
    }
    if (tab.reason === 'closed') this.persist();
  }

  async status(identity) {
    const scope = this.scopes.peek(identity);
    const page = scope && this.tabs.pages.get(scope.currentTabId);
    return { ok: true, daemon: this.stopping ? 'stopping' : 'running', pid: process.pid,
      uptimeMs: Date.now() - this.startedAt, idleMs: Date.now() - this.lastActiveAt,
      idleTimeoutMs: this.config.idleTimeoutMs, browser: this.connection.connected ? 'connected' : 'disconnected',
      endpoint: this.connection.endpoint, scope: scopeKey(identity),
      backend: this.backend, extensionAvailable: this.extensionBridge.connected,
      controlling: Boolean(scope && this.busyScopes.has(scope.key)),
      currentTab: page && this.connection.connected ? await this.tabs.describe(scope.currentTabId, page) : null };
  }

  async dispatch(method, params = {}, identity) {
    if (method === '_preview') return this.preview(params, identity);
    validateCommand(method, params);
    const key = scopeKey(identity);
    if (this.stopping) throw new DtError('daemon is shutting down', -32002);
    if (method === 'status') return this.status(identity);
    const lifecycle = LIFECYCLE.has(method);
    // The observer must not make user commands fail with a spurious lock conflict.
    // Existing user/user conflicts still fail immediately; an in-flight thumbnail
    // may finish before a lifecycle operation takes over.
    if (lifecycle && this.previews.size && !this.busyScopes.size) await Promise.all([...this.previews.values()]);
    if (this.stopping) throw new DtError('daemon is shutting down', -32002);
    if (this.lifecycleBusy || this.busyScopes.has(key) || (lifecycle && this.activeCount)) {
      throw new DtError('another command is still running; retry after it completes', -32003,
        { ownerScope: [...this.busyScopes][0] });
    }
    this.busyScopes.add(key);
    if (lifecycle) this.lifecycleBusy = true;
    this.lastActiveAt = Date.now();
    const fresh = !this.scopes.peek(identity);
    const scope = this.scopes.get(identity);
    const started = Date.now();
    const runtime = this.commands.get(key) || {};
    runtime.current = { cmd: method, startedAt: started };
    this.commands.set(key, runtime);
    if (fresh) this.emit({ type: 'scope.create', scope: key, state: this.scopeSnapshot(scope) });
    this.emit({ type: 'cmd.start', scope: key, cmd: method, startedAt: started, tabId: scope.currentTabId });
    let tabId, token, renewal, result;
    try {
      if (method === 'launch' || method === 'connect') {
        const previousId = this.connection.browserId || readState(this.config).browserId;
        const backend = method === 'connect' && params.extension ? 'extension' : 'cdp';
        const nextConnection = backend === 'extension' ? this.extensionConnection : this.cdpConnection;
        if (nextConnection !== this.connection) {
          if (backend === 'extension' && !this.extensionBridge.connected) throw new DtError('open the DT Browser Bridge popup and click Connect first', -32001);
          this.tabs.reset();
          await this.connection.disconnect({ remember: false });
          this.connection = nextConnection;
          this.backend = backend;
          this.tabs.connection = nextConnection;
        }
        result = method === 'launch'
          ? await this.connection.launch({ port: params.port, profile: params.profile, headless: params.headless })
          : await this.connection.connect(params.port ?? this.config.port);
        if (previousId && previousId !== this.connection.browserId) {
          for (const state of this.scopes.scopes.values()) {
            state.currentTabId = null; state.ownedTabs.clear(); state.reqCache.length = 0;
          }
        }
        await this.tabs.sync();
        result.tabs = await this.tabs.list(scope.currentTabId);
      } else if (method === 'disconnect') {
        this.tabs.reset();
        result = await this.connection.disconnect();
      } else if (method === 'kill') {
        result = await this.kill(params, identity, scope);
      } else if (CACHE.has(method)) {
        result = await this.cacheCommand(method, params, scope);
      } else {
        this.connection.requireContext();
        if (method === 'tabs') {
          result = { ok: true, tabs: await this.tabs.list(scope.currentTabId) };
        } else {
          let page;
          if (method === 'use') {
            await this.tabs.sync();
            page = this.tabs.pages.get(params.id);
            if (!page) throw new DtError('tab not found: ' + params.id);
          }
          else if (method === 'new') ({ page } = await this.tabs.new(scope));
          else page = await this.tabs.current(scope);
          tabId = method === 'use' ? params.id : scope.currentTabId;
          // All page commands receive a lease, including reads: a snapshot of a page being
          // changed concurrently is not reliable. The lease is held until the operation settles.
          await this.previews.get(tabId);
          token = this.locks.acquire(tabId, key);
          if (method === 'use') scope.currentTabId = tabId;
          this.persist();
          renewal = setInterval(() => this.locks.renew(tabId, token), Math.max(1, this.config.lockTtlMs / 3));
          renewal.unref();
          if (method !== 'overlay') await this.tabs.mark(page, scope);
          if (method === 'use' && params.activate) await page.bringToFront();
          if (method === 'new' && params.url && params.url !== 'about:blank') {
            await navigation(page, 'goto', params.url, params.timeout ?? this.config.waitTimeoutMs);
          }
          if (method === 'use' || method === 'new') result = { ok: true, tab: await this.tabs.describe(tabId, page) };
          else result = await this.pageCommand(method, params, scope, page);
          const tab = await this.tabs.describe(tabId, page);
          this.emit({ type: 'tab.change', scope: key, tabId, title: tab.title, url: eventUrl(tab.url), reason: method });
        }
      }
      return result;
    } catch (error) {
      const page = this.tabs.pages.get(scope.currentTabId);
      const data = { ...error?.data, ...(page ? { selector: params.selector, url: page.url(), title: await page.title().catch(() => '') } : {}),
        ...(method === 'run' && error?.stack ? { stack: error.stack } : {}) };
      throw new DtError(error?.message || String(error), error instanceof DtError ? error.code : -32000, data);
    } finally {
      // Release the visible control state before releasing this page's lease.
      // Keep the page, scope, network cache and browser connection for reuse.
      if (token) {
        const page = this.tabs.pages.get(tabId);
        if (page) await this.tabs.unmark(page);
      }
      clearInterval(renewal);
      if (token) this.locks.release(tabId, token);
      this.busyScopes.delete(key);
      if (lifecycle) this.lifecycleBusy = false;
      this.lastActiveAt = Date.now();
      scope.lastActiveAt = new Date().toISOString();
      runtime.current = null;
      runtime.last = { cmd: method, ok: Boolean(result?.ok), ms: Date.now() - started, endedAt: Date.now() };
      if (!this.scopes.scopes.has(key)) this.commands.delete(key);
      audit(this.config, scope, method, params, result);
      this.persist();
      this.emit({ type: 'cmd.end', scope: key, ...runtime.last });
      if (lifecycle) this.emit(this.eventSnapshot());
    }
  }

  async preview(params, identity) {
    const key = scopeKey(identity);
    const scope = this.scopes.peek(identity);
    if (!scope || scope.createdAt !== params.createdAt || scope.currentTabId !== params.tabId) {
      throw new DtError('preview target changed', -32602);
    }
    if (this.stopping || (!this.busyScopes.size && Date.now() - this.lastActiveAt >= this.config.idleTimeoutMs)) {
      throw new DtError('daemon is idle or stopping', -32002);
    }
    if (this.lifecycleBusy || this.busyScopes.has(key)) throw new DtError('page is being operated', -32003);
    this.connection.requireContext();
    const page = this.tabs.pages.get(params.tabId);
    if (!page || page.isClosed()) throw new DtError('preview page unavailable', -32001);
    const token = this.locks.acquire(params.tabId, key);
    let finish;
    this.previews.set(params.tabId, new Promise((resolve) => { finish = resolve; }));
    this.previewCount++;
    const renewal = setInterval(() => this.locks.renew(params.tabId, token), Math.max(1, this.config.lockTtlMs / 3));
    let session;
    try {
      session = await page.context().newCDPSession(page);
      // Capture the existing surface without clip scaling: scaling here can
      // temporarily resize the page and cause visible reflow during previews.
      const { data } = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 55,
        fromSurface: true, captureBeyondViewport: false });
      return { ok: true, tabId: params.tabId, image: 'data:image/jpeg;base64,' + data, capturedAt: Date.now() };
    } finally {
      await session?.detach().catch(() => {});
      clearInterval(renewal); this.locks.release(params.tabId, token); this.previewCount--;
      this.previews.delete(params.tabId); finish();
    }
  }

  async kill(params, identity, scope) {
    if (params.daemon) {
      const browserClosed = params.browser ? await this.connection.closeBrowser() : false;
      if (browserClosed) this.scopes.scopes.clear();
      this.stopping = true;
      return { ok: true, daemon: 'stopping', browserClosed, _shutdownDaemon: true };
    }
    const states = params.session
      ? this.scopes.bySession(params.session === true ? identity.sessionId : params.session) : [scope];
    let closedTabs = 0;
    if (this.connection.connected) await this.tabs.sync();
    else if (states.some((state) => state.ownedTabs.size)) {
      throw new DtError('connect the browser before closing owned tabs', -32001);
    }
    for (const state of states) {
      closedTabs += await this.tabs.closeOwned(state);
      this.scopes.scopes.delete(state.key);
      this.commands.delete(state.key);
      this.emit({ type: 'scope.destroy', scope: state.key, reason: 'kill' });
    }
    return { ok: true, clearedScopes: states.length, closedTabs };
  }

  async pageCommand(method, params, scope, page) {
    if (['goto', 'reload', 'back'].includes(method)) {
      return navigation(page, method, params.url, params.timeout ?? this.config.waitTimeoutMs);
    }
    if (['click', 'dblclick', 'type', 'fill', 'select', 'wait', 'waitms'].includes(method)) {
      return act(page, method, params, this.config.waitTimeoutMs);
    }
    if (method === 'snapshot') return takeSnapshot(page, params.image);
    if (method === 'shot') {
      const file = params.file || path.join(this.config.shotsDir, Date.now() + '.png');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, fullPage: Boolean(params.fullPage) });
      return { ok: true, file };
    }
    if (method === 'title') return { ok: true, title: await page.title() };
    if (method === 'url') return { ok: true, url: page.url() };
    if (method === 'eval') return evaluate(page, params.expression);
    if (method === 'ls.elements') return listElements(page, params.selector);
    if (method.startsWith('ck.')) return cookies(page, method.slice(3), params.key, params.value);
    if (method === 'ls.get' || method === 'ls.set') return localStorage(page, method.slice(3), params.key, params.value);
    if (method === 'overlay') {
      scope.overlayOn = params.enabled;
      await this.tabs.mark(page, scope);
      return { ok: true, enabled: params.enabled };
    }
    if (method === 'run') {
      const module = await import(pathToFileURL(params.file).href + '?t=' + Date.now());
      if (typeof module.default !== 'function') throw new DtError('script must default-export an async function');
      return { ok: true, result: await module.default({ page, context: page.context() }) };
    }
    throw new DtError('unknown method: ' + method, -32601);
  }

  async cacheCommand(method, params, scope) {
    if (method === 'reqclear') {
      scope.reqCache.length = 0;
      this.emit({ type: 'net.clear', scope: scope.key, requestCount: 0 });
      return { ok: true, cleared: true };
    }
    if (method === 'reqs') {
      const requests = filterRequests(scope.reqCache, params.filter).map(requestSummary);
      return { ok: true, total: scope.reqCache.length, filtered: requests.length, requests };
    }
    if (method === 'har') {
      const file = params.file || path.join(this.config.stateDir, Date.now() + '.har');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(toHar(scope.reqCache, { redact: params.redact !== false }), null, 2) + '\n', { mode: 0o600 });
      return { ok: true, file, entries: scope.reqCache.length, redacted: params.redact !== false };
    }
    const item = scope.reqCache.find((request) => request.n === Number(params.n));
    if (!item) throw new DtError('request not found: ' + params.n);
    if (method === 'req') {
      return { ok: true, request: { n: item.n, method: item.method, url: item.url,
        headers: redactHeaders(item.requestHeaders), query: queryParams(item.url),
        postData: item.postData, truncated: item.postDataTruncated, resourceType: item.resourceType } };
    }
    return { ok: true, response: { n: item.n, status: item.status, statusText: item.statusText,
      headers: redactHeaders(item.responseHeaders), body: item.body ?? null, bodyOmitted: item.bodyOmitted,
      failure: item.failure } };
  }
}
