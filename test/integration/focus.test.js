import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { BrowserAgentApi } from '../../src/api.js';
import { getConfig, ensureStateDir } from '../../src/config.js';
import { chromium } from 'playwright-core';
import { chromeExecutable } from '../../src/core/connection.js';

test('headed Chrome keeps the foreground tab during background creation and default use',
  { skip: !process.env.DT_FOCUS_INTEGRATION, timeout: 40_000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-focus-'));
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const config = { ...getConfig(), stateDir: root, shotsDir: path.join(root, 'shots'), statePath: path.join(root, 'state.json'),
      auditPath: path.join(root, 'audit.log'), port, profileDir: path.join(root, 'profile') };
    ensureStateDir(config);
    const context = await chromium.launchPersistentContext(config.profileDir, {
      executablePath: chromeExecutable(), headless: false, ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--remote-debugging-port=${port}`, '--enable-unsafe-extension-debugging'],
    });
    const api = new BrowserAgentApi(config);
    const identity = { sessionId: 'focus-test', taskId: 'first' };
    t.after(async () => { api.tabs.reset(); await api.connection.disconnect({ remember: false }); await context.close(); });
    // Read actual Chrome tab activation through a tiny test-only extension. Playwright's
    // focus emulation makes document.visibilityState unsuitable for this assertion.
    const extension = path.join(root, 'focus-extension');
    fs.mkdirSync(extension);
    fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'DT focus fixture',
      version: '1.0', permissions: ['tabs'], background: { service_worker: 'worker.js' } }));
    fs.writeFileSync(path.join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
    const control = await context.browser().newBrowserCDPSession();
    await control.send('Extensions.loadUnpacked', { path: extension });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const foreground = context.pages()[0];
    await foreground.goto('data:text/html,<title>Foreground fixture</title>Foreground');
    await foreground.bringToFront();
    const activeTab = () => worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    const original = await activeTab();
    await api.dispatch('connect', { port }, identity);
    await api.dispatch('title', {}, identity);
    assert.equal(await activeTab(), original, 'automatic workspace stays in the background');
    const created = await api.dispatch('new', {}, identity);
    assert.equal(await activeTab(), original, 'explicit new stays in the background');
    await api.dispatch('use', { id: created.tab.id }, identity);
    assert.equal(await activeTab(), original, 'default use does not activate');
    await api.dispatch('use', { id: created.tab.id, activate: true }, identity);
    assert.notEqual(await activeTab(), original, 'explicit activation switches tabs');
    await control.detach();
    t.diagnostic('Headed focus fixture: ' + root);
  });
