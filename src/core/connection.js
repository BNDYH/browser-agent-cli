import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DtError } from '../errors.js';
import { expandHome } from '../config.js';
import { readState, writeState } from '../session.js';

export function chromeExecutable() {
  if (process.env.DT_CHROME_PATH) return process.env.DT_CHROME_PATH;
  const candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export async function browserVersion(port, timeout = 1500) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DtError('port must be between 1 and 65535', -32602);
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error('not a Chrome debugging endpoint');
  const data = await response.json();
  const ws = new URL(data.webSocketDebuggerUrl);
  if (ws.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(ws.hostname)) {
    throw new DtError('Chrome endpoint must use a loopback WebSocket');
  }
  // Resolve localhost deterministically and never follow a remote debugging endpoint.
  ws.hostname = '127.0.0.1';
  return { ...data, webSocketDebuggerUrl: ws.href };
}

export class Connection {
  constructor(config, onDisconnect = () => {}) {
    this.config = config;
    this.onDisconnect = onDisconnect;
    this.browser = null;
    this.context = null;
    this.endpoint = null;
    this.browserId = null;
    this.browserPid = null;
    this.launchedBrowser = false;
  }

  get connected() { return Boolean(this.browser?.isConnected()); }

  async restore() {
    const state = readState(this.config);
    if (state.backend === 'extension' || !state.port || state.disconnected) return false;
    try { await this.connect(state.port); return true; }
    catch { return false; }
  }

  async connect(port = this.config.port) {
    const endpoint = `http://127.0.0.1:${port}`;
    let info, browser;
    try {
      info = await browserVersion(port);
      if (this.connected && this.browserId === info.webSocketDebuggerUrl) return { ok: true, endpoint };
      // Preserve the existing browser's download, focus and media settings.
      browser = await chromium.connectOverCDP(info.webSocketDebuggerUrl, { timeout: 10_000, noDefaults: true });
    } catch (error) {
      throw new DtError(`cannot connect to Chrome at ${endpoint}. Start Chrome with --remote-debugging-port=${port} and a separate --user-data-dir. ${error.message}`, -32001, { endpoint });
    }
    const previous = readState(this.config);
    if (this.browser) await this.disconnect({ remember: false });
    this.browser = browser;
    this.context = browser.contexts()[0];
    if (!this.context) { await browser.close(); throw new DtError('browser has no context', -32001); }
    this.endpoint = endpoint;
    this.browserId = info.webSocketDebuggerUrl;
    const sameBrowser = previous.browserId === this.browserId;
    this.launchedBrowser = sameBrowser && Boolean(previous.launchedBrowser);
    this.browserPid = this.launchedBrowser ? previous.browserPid : null;
    browser.on('disconnected', () => {
      if (this.browser === browser) { this.browser = null; this.context = null; this.onDisconnect(); }
    });
    this.persist({ backend: 'cdp', port, disconnected: false, ...(sameBrowser ? {} : { scopes: [] }) });
    return { ok: true, endpoint };
  }

  persist(extra = {}) {
    writeState({
      ...readState(this.config), browserId: this.browserId, endpoint: this.endpoint,
      launchedBrowser: this.launchedBrowser, browserPid: this.browserPid, ...extra,
    }, this.config);
  }

  async launch({ port = this.config.port, profile = this.config.profileDir, headless = false } = {}) {
    let existing;
    try { existing = await browserVersion(port, 500); } catch {}
    if (existing) return { ...await this.connect(port), reused: true };
    const executable = chromeExecutable();
    if (!executable) throw new DtError('Chrome/Chromium executable not found; set DT_CHROME_PATH');
    profile = path.resolve(expandHome(profile));
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const log = fs.openSync(path.join(this.config.stateDir, 'chrome.log'), 'a', 0o600);
    const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'];
    if (headless) args.unshift('--headless=new');
    const child = spawn(executable, args, { detached: true, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    let spawnError;
    child.on('error', (error) => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline && !spawnError) {
      try { await browserVersion(port, 500); ready = true; break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) {
      if (child.pid && child.exitCode === null) child.kill('SIGTERM');
      throw new DtError(spawnError?.message || `Chrome did not open debugging port ${port}; see chrome.log`);
    }
    await this.connect(port);
    this.launchedBrowser = true;
    this.browserPid = child.pid;
    this.persist({ port, profileDir: profile });
    return { ok: true, browser: 'chrome', endpoint: this.endpoint, pid: child.pid, profile };
  }

  async disconnect({ remember = true } = {}) {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    if (browser) await browser.close().catch(() => {});
    if (remember) this.persist({ disconnected: true });
    return { ok: true, browser: 'disconnected' };
  }

  async closeBrowser() {
    if (!this.launchedBrowser || !this.connected) throw new DtError('only the connected browser launched by dt can be closed');
    // Close the verified CDP browser, never a possibly recycled OS process ID.
    const session = await this.browser.newBrowserCDPSession();
    await session.send('Browser.close').catch((error) => {
      if (this.connected) throw error;
    });
    this.launchedBrowser = false;
    this.browserPid = null;
    this.persist({ disconnected: true, scopes: [] });
    return true;
  }

  requireContext() {
    if (!this.connected || !this.context) throw new DtError('browser is not connected; run dt launch or dt connect', -32001);
    return this.context;
  }
}
