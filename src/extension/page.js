import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { DtError } from '../errors.js';
import { ExtensionLocator } from './locator.js';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function unwrap(response) {
  if (response.exceptionDetails) throw new DtError(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  const result = response.result;
  if (result?.unserializableValue) return result.unserializableValue;
  return result?.value;
}

export class ExtensionFrame {
  constructor(page, id) { this.page = page; this.id = id; }
  locator(selector) { return new ExtensionLocator(this.page, selector, this.id); }
}

export class ExtensionPage extends EventEmitter {
  constructor(context, tab) {
    super(); this.owner = context; this.tab = tab; this.closed = false;
    this.stableId = `ext:${context.connection.browserId.slice(10)}:${tab.id}`;
    this.frameIds = []; this.requests = new Map(); this.waiters = new Set(); this.blocked = false;
  }
  context() { return this.owner; }
  url() { return this.tab.url || 'about:blank'; }
  async title() { await this.refresh(); return this.tab.title || ''; }
  isClosed() { return this.closed; }
  async refresh() { this.tab = await this.owner.connection.bridge.call('tabs.get', { tabId: this.tab.id }); }
  async attach() {
    if (this.blocked) throw new DtError('debugger detached; reconnect in the extension popup', -32001);
    await this.owner.connection.bridge.call('debug.attach', { tabId: this.tab.id });
  }
  async send(method, params = {}, timeout) {
    if (this.blocked) throw new DtError('debugger detached; reconnect in the extension popup', -32001);
    const result = await this.owner.connection.bridge.call('debug.send', { tabId: this.tab.id, method, params }, timeout);
    if (method === 'Page.getFrameTree') {
      this.frameIds = [];
      const walk = (tree) => { this.frameIds.push(tree.frame.id); for (const child of tree.childFrames || []) walk(child); };
      walk(result.frameTree);
    }
    return result;
  }
  async evaluate(fn, arg) {
    return unwrap(await this.send('Runtime.evaluate', { expression: typeof fn === 'function'
      ? `(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})` : String(fn),
    awaitPromise: true, returnByValue: true, userGesture: true }));
  }
  async evaluateInFrame(expression, frameId, byValue = false) {
    const contextId = frameId ? (await this.send('Page.createIsolatedWorld', { frameId, worldName: 'dt-locator' })).executionContextId : undefined;
    const result = await this.send('Runtime.evaluate', { expression, contextId, returnByValue: byValue, awaitPromise: true });
    if (result.exceptionDetails) unwrap(result);
    return byValue ? unwrap(result) : result.result;
  }
  frames() { return this.frameIds.length ? this.frameIds.map((id) => new ExtensionFrame(this, id)) : [new ExtensionFrame(this)]; }
  locator(selector) { return new ExtensionLocator(this, selector); }
  async waitForTimeout(ms) { await delay(ms); }
  async bringToFront() { this.tab = await this.owner.connection.bridge.call('tabs.activate', { tabId: this.tab.id }); }

  async navigate(method, params, timeout = 10_000) {
    await this.attach();
    let committed = false;
    const listener = (name, data) => {
      if (name === 'Page.frameNavigated' && !data.frame.parentId || name === 'Page.navigatedWithinDocument') committed = true;
    };
    this.waiters.add(listener);
    try {
      const response = await this.send(method, params);
      if (response.errorText) throw new DtError(response.errorText);
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (committed) {
          try {
            if (await this.evaluate(() => document.readyState !== 'loading')) { await this.refresh(); return; }
          } catch { /* A new execution context may still be committing. */ }
        }
        await delay(50);
      }
      throw new DtError('navigation timed out; inspect url/snapshot before retrying');
    } finally { this.waiters.delete(listener); }
  }
  goto(url, options = {}) { return this.navigate('Page.navigate', { url }, options.timeout); }
  reload(options = {}) { return this.navigate('Page.reload', {}, options.timeout); }
  async goBack(options = {}) {
    const history = await this.send('Page.getNavigationHistory');
    if (!history.currentIndex) return null;
    await this.navigate('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex - 1].id }, options.timeout);
  }
  async screenshot({ path, fullPage = false } = {}) {
    let clip;
    if (fullPage) {
      const { cssContentSize } = await this.send('Page.getLayoutMetrics');
      if (cssContentSize.width * cssContentSize.height > 32_000_000) throw new DtError('full page screenshot exceeds 32 megapixels');
      clip = { ...cssContentSize, scale: 1 };
    }
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
    const bytes = Buffer.from(data, 'base64');
    if (path) await fs.writeFile(path, bytes);
    return bytes;
  }
  async close() {
    await this.owner.connection.bridge.call('tabs.close', { tabId: this.tab.id });
    this.closed = true; this.emit('close');
  }

  handleEvent(method, params) {
    for (const listener of this.waiters) listener(method, params);
    if (method === 'DT.tab') { this.tab = params; this.emit('tabchange'); }
    if (method === 'DT.closed') { this.closed = true; this.emit('close'); }
    if (method === 'DT.detached') { this.blocked = true; this.requests.clear(); }
    if (method === 'Page.domContentEventFired') this.emit('domcontentloaded');
    if (method === 'Page.frameNavigated' && !params.frame.parentId) this.tab.url = params.frame.url;
    if (method === 'Network.requestWillBeSent') {
      if (params.redirectResponse && this.requests.has(params.requestId)) {
        const old = this.requests.get(params.requestId);
        old.reply = new ResponseFacade(this, params.requestId, old, params.redirectResponse);
        this.emit('response', old.reply); this.emit('requestfinished', old);
      }
      const request = new RequestFacade(params);
      this.requests.set(params.requestId, request);
      if (this.requests.size > 2000) this.requests.delete(this.requests.keys().next().value);
      this.emit('request', request);
    }
    const request = this.requests.get(params.requestId);
    if (!request) return;
    if (method === 'Network.responseReceived') {
      request.reply = new ResponseFacade(this, params.requestId, request, params.response);
      this.emit('response', request.reply);
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      if (method === 'Network.loadingFailed') request.error = params.errorText;
      this.emit(request.error ? 'requestfailed' : 'requestfinished', request);
      this.requests.delete(params.requestId);
    }
  }
}
class RequestFacade {
  constructor(data) { this.data = data; this.reply = null; }
  method() { return this.data.request.method; }
  url() { return this.data.request.url; }
  resourceType() { return (this.data.type || 'other').toLowerCase(); }
  headers() { return normalizeHeaders(this.data.request.headers); }
  postData() { return this.data.request.postData || null; }
  failure() { return this.error ? { errorText: this.error } : null; }
  async response() { return this.reply; }
}
function normalizeHeaders(headers) { return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)])); }
class ResponseFacade {
  constructor(page, id, request, data) { this.page = page; this.id = id; this.req = request; this.data = data; }
  request() { return this.req; }
  status() { return this.data.status; }
  statusText() { return this.data.statusText; }
  async allHeaders() { return normalizeHeaders(this.data.headers); }
  async body() {
    const result = await this.page.send('Network.getResponseBody', { requestId: this.id });
    return Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
  }
}
