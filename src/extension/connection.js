import { EventEmitter } from 'node:events';
import { readState, writeState } from '../session.js';
import { DtError } from '../errors.js';
import { ExtensionPage } from './page.js';

export class ExtensionConnection {
  constructor(config, bridge) {
    this.config = config; this.bridge = bridge; this.context = null; this.browserId = null; this.enabled = false;
    this.endpoint = 'native-messaging'; this.launchedBrowser = false;
    bridge.on('disconnected', () => { this.enabled = false; this.context = null; });
    bridge.on('event', ({ tabId, method, params }) => this.context?.tabPages.get(tabId)?.handleEvent(method, params));
  }
  get connected() { return this.enabled && this.bridge.connected && this.browserId === this.bridge.browserId; }
  async restore() { return false; } // Explicit popup connection is needed after native port closes.
  async connect() {
    if (!this.bridge.connected) throw new DtError('open DT Browser Bridge in Chrome and click Connect, then run dt connect --extension', -32001);
    if (this.connected) return { ok: true, backend: 'extension', endpoint: this.endpoint };
    this.browserId = this.bridge.browserId;
    this.context = new ExtensionContext(this);
    this.enabled = true;
    try { await this.context.refresh(); } catch (error) { this.enabled = false; throw error; }
    writeState({ ...readState(this.config), backend: 'extension', browserId: this.browserId,
      endpoint: this.endpoint, disconnected: false, launchedBrowser: false, browserPid: null }, this.config);
    return { ok: true, backend: 'extension', endpoint: this.endpoint };
  }
  async disconnect({ remember = true } = {}) {
    if (this.bridge.connected) await this.bridge.call('debug.detachAll');
    this.enabled = false; this.context = null;
    if (remember) writeState({ ...readState(this.config), disconnected: true }, this.config);
    return { ok: true, browser: 'disconnected', backend: 'extension' };
  }
  async closeBrowser() { throw new DtError('--browser cannot close a user Chrome connected through the extension', -32602); }
  requireContext() {
    if (!this.connected) throw new DtError('extension browser is not connected; run dt connect --extension', -32001);
    return this.context;
  }
}

class ExtensionContext extends EventEmitter {
  constructor(connection) { super(); this.connection = connection; this.tabPages = new Map(); }
  pages() { return [...this.tabPages.values()].filter((page) => !page.closed); }
  register(tab) {
    if (!this.tabPages.has(tab.id)) {
      const page = new ExtensionPage(this, tab);
      this.tabPages.set(tab.id, page);
      page.on('close', () => this.tabPages.delete(tab.id));
      this.emit('page', page);
    } else this.tabPages.get(tab.id).tab = tab;
    return this.tabPages.get(tab.id);
  }
  async refresh() {
    const tabs = await this.connection.bridge.call('tabs.list');
    const present = new Set(tabs.map((tab) => tab.id));
    for (const [id, page] of this.tabPages) if (!present.has(id)) { page.closed = true; page.emit('close'); }
    tabs.forEach((tab) => this.register(tab));
  }
  async newPage() { return this.register(await this.connection.bridge.call('tabs.new')); }
  async newCDPSession(page) {
    await page.attach();
    return { send: (method, params) => page.send(method, params), detach: async () => {} };
  }
}
