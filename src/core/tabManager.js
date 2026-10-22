import { DtError } from '../errors.js';
import { setOverlay } from './overlay.js';

export class TabManager {
  constructor(connection, network, onChange = () => {}) {
    this.connection = connection;
    this.network = network;
    this.pages = new Map();
    this.ids = new WeakMap();
    this.pending = new WeakMap();
    this.context = null;
    this.control = new WeakMap();
    this.onChange = onChange;
    this.metadata = new Map();
    this.listeners = new Map();
  }

  reset() {
    if (this.context && this.onPage) this.context.off('page', this.onPage);
    for (const [page, handlers] of this.listeners) {
      for (const [event, handler] of handlers) page.off(event, handler);
    }
    this.listeners.clear();
    this.pages.clear();
    this.metadata.clear();
    this.ids = new WeakMap();
    this.pending = new WeakMap();
    this.context = null;
  }

  async sync() {
    const context = this.connection.requireContext();
    if (context.refresh) await context.refresh();
    if (this.context !== context) {
      this.reset();
      this.context = context;
      this.onPage = (page) => { void this.register(page).catch(() => {}); };
      context.on('page', this.onPage);
    }
    await Promise.all(context.pages().map((page) => this.register(page)));
  }

  async register(page) {
    if (this.ids.has(page)) return this.ids.get(page);
    if (this.pending.has(page)) return this.pending.get(page);
    const pending = (async () => {
      const context = page.context();
      let id = page.stableId;
      if (!id) {
        const session = await page.context().newCDPSession(page);
        try { id = (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
        finally { await session.detach(); }
      }
      if (context !== this.context || page.isClosed()) throw new DtError('page disconnected while registering');
      this.ids.set(page, id);
      this.pages.set(id, page);
      this.network.attach(page, id);
      const close = () => {
        if (this.pages.get(id) !== page) return;
        this.pages.delete(id);
        this.metadata.delete(id);
        for (const [event, handler] of this.listeners.get(page) || []) page.off(event, handler);
        this.listeners.delete(page);
        this.onChange({ id, reason: 'closed' });
      };
      const changed = () => { void this.refreshMetadata(id, page).catch(() => {}); };
      const loaded = () => {
        const scope = this.control.get(page);
        if (scope) void setOverlay(page, scope.overlayOn, scope.key).catch(() => {});
        changed();
      };
      const navigated = (frame) => { if (frame === page.mainFrame()) changed(); };
      const handlers = [['close', close], ['domcontentloaded', loaded], ['framenavigated', navigated], ['tabchange', changed]];
      this.listeners.set(page, handlers);
      for (const [event, handler] of handlers) page.on(event, handler);
      await this.refreshMetadata(id, page);
      return id;
    })();
    this.pending.set(page, pending);
    try { return await pending; } finally { this.pending.delete(page); }
  }

  async mark(page, scope) {
    this.control.set(page, scope);
    await setOverlay(page, scope.overlayOn, scope.key).catch(() => {});
  }

  async unmark(page) {
    this.control.delete(page);
    await setOverlay(page, false).catch(() => {});
  }

  async list(activeId = null) {
    await this.sync();
    return Promise.all([...this.pages].map(async ([id, page]) => ({
      id, title: await page.title().catch(() => ''), url: page.url(), active: id === activeId,
    })));
  }

  async new(scopeState, url = 'about:blank', timeout = this.connection.config.waitTimeoutMs) {
    await this.sync();
    let page, id;
    if (this.connection.browser) {
      const session = await this.connection.browser.newBrowserCDPSession();
      let targetId;
      try {
        ({ targetId } = await session.send('Target.createTarget', { url: 'about:blank', background: true }));
        const deadline = Date.now() + timeout;
        do {
          await this.sync();
          page = this.pages.get(targetId);
          if (page && !page.isClosed()) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        if (!page || page.isClosed()) throw new DtError('new background tab did not become available');
        id = targetId;
      } catch (error) {
        if (targetId) await session.send('Target.closeTarget', { targetId }).catch(() => {});
        throw error;
      } finally { await session.detach().catch(() => {}); }
    } else {
      page = await this.connection.requireContext().newPage();
      try { id = await this.register(page); }
      catch (error) { await page.close().catch(() => {}); throw error; }
    }
    scopeState.currentTabId = id;
    scopeState.ownedTabs.add(id);
    if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    return { id, page };
  }

  async current(scopeState, create = true) {
    await this.sync();
    let page = scopeState.currentTabId ? this.pages.get(scopeState.currentTabId) : null;
    if (!page && create) ({ page } = await this.new(scopeState));
    if (!page) throw new DtError('current tab is unavailable');
    return page;
  }

  async use(scopeState, id) {
    await this.sync();
    const page = this.pages.get(String(id));
    if (!page) throw new DtError(`tab not found: ${id}`);
    scopeState.currentTabId = String(id);
    return page;
  }

  async describe(id, page) {
    return await this.refreshMetadata(String(id), page);
  }

  async refreshMetadata(id, page) {
    const url = page.url();
    const tab = { id, title: await page.title().catch(() => ''), url };
    if (this.pages.get(id) !== page || page.isClosed()) return tab;
    // A later navigation may have overtaken this title request.
    if (page.url() !== url) return this.metadata.get(id) || tab;
    const previous = this.metadata.get(id);
    this.metadata.set(id, tab);
    if (!previous || previous.title !== tab.title || previous.url !== url) this.onChange({ ...tab, reason: 'updated' });
    return tab;
  }

  async closeOwned(scopeState) {
    let closed = 0;
    for (const id of scopeState.ownedTabs) {
      const page = this.pages.get(id);
      if (page && !page.isClosed()) { await page.close(); closed++; }
    }
    scopeState.ownedTabs.clear();
    return closed;
  }
}
