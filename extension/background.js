// This extension accepts commands only from its native host, not web pages/content scripts.
const HOST = 'com.browser_agent_cli.dt';
let port = null;
let connected = false;
let lastError = '';
const attached = new Set();
const blocked = new Set();
const attaching = new Map();
const allowedDomains = new Set(['Page', 'Runtime', 'DOM', 'Accessibility', 'Input', 'Network', 'Target']);

function send(message) { try { port?.postMessage(message); } catch { /* onDisconnect handles cleanup */ } }
function badge(text) { void chrome.action.setBadgeText({ text }); }
function tabId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid Chrome tab ID');
  return value;
}
function publicTab(tab) {
  return { id: tab.id, title: tab.title || '', url: tab.url || '', active: tab.active, windowId: tab.windowId, incognito: tab.incognito };
}
async function attach(id) {
  tabId(id);
  if (blocked.has(id)) throw new Error('Chrome debugger was detached by the user or DevTools. Reconnect in the DT popup to resume.');
  if (attached.has(id)) return;
  if (attaching.has(id)) return attaching.get(id);
  const work = (async () => {
    const tab = await chrome.tabs.get(id);
    if (!/^(https?:|file:|about:blank)/.test(tab.url || '')) throw new Error('Chrome internal pages and extension pages cannot be controlled');
    await chrome.debugger.attach({ tabId: id }, '1.3');
    attached.add(id);
    await chrome.debugger.sendCommand({ tabId: id }, 'Page.enable');
    await chrome.debugger.sendCommand({ tabId: id }, 'Runtime.enable');
    await chrome.debugger.sendCommand({ tabId: id }, 'Network.enable', {
      maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024, maxPostDataSize: 65536,
    });
    badge(String(attached.size));
  })();
  attaching.set(id, work);
  try { await work; } finally { attaching.delete(id); }
}
async function detachAll() {
  await Promise.allSettled([...attached].map(async (id) => {
    attached.delete(id);
    await chrome.debugger.detach({ tabId: id });
  }));
  badge(connected ? 'ON' : '');
}
export async function dispatch(method, params = {}) {
  if (method === 'tabs.list') return (await chrome.tabs.query({})).map(publicTab);
  if (method === 'tabs.get') return publicTab(await chrome.tabs.get(tabId(params.tabId)));
  if (method === 'tabs.new') return publicTab(await chrome.tabs.create({ url: 'about:blank', active: false }));
  if (method === 'tabs.activate') {
    const tab = await chrome.tabs.update(tabId(params.tabId), { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return publicTab(tab);
  }
  if (method === 'tabs.close') { await chrome.tabs.remove(tabId(params.tabId)); return {}; }
  if (method === 'debug.attach') { await attach(params.tabId); return {}; }
  if (method === 'debug.detachAll') { await detachAll(); return {}; }
  if (method === 'debug.send') {
    const domain = String(params.method).split('.')[0];
    if (!allowedDomains.has(domain) || params.method.startsWith('Target.') && params.method !== 'Target.getTargetInfo') {
      throw new Error('CDP method is not available in extension mode: ' + params.method);
    }
    await attach(params.tabId);
    return chrome.debugger.sendCommand({ tabId: params.tabId }, params.method, params.params || {});
  }
  throw new Error('unknown bridge method: ' + method);
}
async function connect() {
  if (port) return;
  blocked.clear();
  lastError = '';
  const saved = await chrome.storage.session.get('browserId');
  const browserId = saved.browserId || crypto.randomUUID();
  if (!saved.browserId) await chrome.storage.session.set({ browserId });
  port = chrome.runtime.connectNative(HOST);
  const current = port;
  current.onDisconnect.addListener(() => {
    if (port !== current) return;
    lastError = chrome.runtime.lastError?.message || '本地连接已关闭，请重新连接';
    port = null; connected = false;
    void detachAll();
  });
  current.onMessage.addListener((message) => {
    if (message.type === 'ready') { connected = true; badge('ON'); return; }
    if (message.type === 'error') { lastError = message.message; return; }
    if (message.type !== 'command') return;
    void dispatch(message.method, message.params).then(
      (result) => send({ type: 'response', id: message.id, result }),
      (error) => send({ type: 'response', id: message.id, error: { code: -32000, message: error.message } }),
    );
  });
  send({ type: 'hello', protocol: 1, browserId, extensionId: chrome.runtime.id });
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (attached.has(source.tabId) && !source.sessionId) send({ type: 'event', tabId: source.tabId, method, params });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (!attached.has(source.tabId)) return;
  attached.delete(source.tabId);
  blocked.add(source.tabId);
  send({ type: 'event', tabId: source.tabId, method: 'DT.detached', params: { reason } });
  badge(attached.size ? String(attached.size) : (connected ? 'ON' : ''));
});
chrome.tabs.onRemoved.addListener((id) => {
  attached.delete(id); blocked.delete(id);
  send({ type: 'event', tabId: id, method: 'DT.closed', params: {} });
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url || change.title || change.status === 'complete') {
    send({ type: 'event', tabId: id, method: 'DT.tab', params: publicTab(tab) });
  }
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  void (async () => {
    if (message.action === 'connect') {
      if (port) { port.disconnect(); port = null; connected = false; await detachAll(); }
      await connect();
    }
    if (message.action === 'disconnect') {
      const previous = port; port = null; connected = false;
      await detachAll(); previous?.disconnect(); lastError = '';
    }
    return { connected, connecting: Boolean(port) && !connected, attached: attached.size, error: lastError };
  })().then(respond, (error) => respond({ connected: false, error: error.message }));
  return true;
});
