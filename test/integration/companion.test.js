import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { createRpcServer } from '../../src/daemon/rpc.js';

test('companion Electron UI: current-page thumbnail, hidden polling, offline and reconnect',
  { skip: !process.env.DT_COMPANION_INTEGRATION, timeout: 180_000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-panel-'));
    const socketPath = path.join(root, 'daemon.sock');
    const subscribers = new Set(), connections = new Set(); const calls = [];
    let revision = 1, previewImage, autoShow = true;
    const scope = { key: 'fixture/edit', sessionId: 'fixture', taskId: 'edit', createdAt: 'fixture-generation',
      currentCommand: null, lastCommand: { cmd: 'snapshot', ok: true },
      currentTab: { id: 'target', title: '<img src=x onerror=alert(1)>', url: 'https://example.test/form' },
      requestCount: 1, recentRequests: [{ n: 5, method: 'POST', url: 'https://example.test/api', status: 200, ms: 20 }] };
    let scopes = [scope];
    const server = createRpcServer(socketPath, async (method, params, identity) => {
      calls.push({ method, params, identity });
      if (method === 'companion') {
        autoShow = params.enabled;
        for (const peer of subscribers) peer.write(JSON.stringify({ type: 'daemon.status', revision: revision++, idleMs: 1000,
          browser: 'connected', scopes, companionAutoShow: autoShow }) + '\n');
        return { ok: true, autoShow };
      }
      if (method === 'use') {
        const selected = scopes.find(item => item.currentTab.id === params.id);
        assert.ok(selected);
        assert.deepEqual(params, { id: selected.currentTab.id, activate: true });
        assert.deepEqual(identity, { sessionId: selected.sessionId, taskId: selected.taskId });
        return { ok: true, tab: selected.currentTab };
      }
      assert.equal(method, '_preview', 'the preview window must not fetch requests or manage tasks');
      return { ok: true, image: previewImage, tabId: params.tabId, capturedAt: Date.now() };
    }, { subscribe(peer) {
      subscribers.add(peer); peer.on('close', () => subscribers.delete(peer));
      peer.write(JSON.stringify({ type: 'daemon.status', revision: revision++, idleMs: 1000, idleTimeoutMs: 60_000,
        browser: 'connected', activeCount: 0, scopes }) + '\n');
    } });
    server.on('connection', (peer) => { connections.add(peer); peer.on('close', () => connections.delete(peer)); });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    t.after(async () => { for (const peer of connections) peer.destroy(); await new Promise((resolve) => server.close(resolve)); });
    const require = createRequire(new URL('../../companion/package.json', import.meta.url));
    const electron = await _electron.launch({ executablePath: require('electron'),
      args: [fileURLToPath(new URL('../../companion/', import.meta.url)), '--user-data-dir=' + path.join(root, 'electron-profile')],
      env: { ...process.env, DT_STATE_DIR: root }, timeout: 20_000 });
    t.after(() => electron.close());
    const window = await electron.firstWindow();
    window.setDefaultTimeout(10_000);
    window.on('pageerror', (error) => t.diagnostic(error.message));
    previewImage = await electron.evaluate(async ({ BrowserWindow }) => {
      const fixture = new BrowserWindow({ show: false, width: 1000, height: 650, webPreferences: { sandbox: true } });
      await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>body{font:20px system-ui;background:#f6f7fb;padding:50px;color:#243849}section{background:white;padding:35px;border-radius:15px}label{display:block;margin:20px 0}input{font:inherit;padding:10px;border:1px solid #dde3ea;border-radius:6px}button{padding:12px 32px;background:#386e62;color:white;border:0;border-radius:6px}</style><h1>订单工作台</h1><section><h2>新建订单</h2><label>商品名称 <input value="折叠椅"></label><label>采购数量 <input value="10"></label><button>保存订单</button></section>'));
      const image = await fixture.webContents.capturePage();
      const data = 'data:image/jpeg;base64,' + image.toJPEG(60).toString('base64');
      fixture.destroy(); return data;
    });
    scope.lastCommand.endedAt = Date.now();
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'cmd.end', revision: revision++, scope: scope.key, cmd: 'snapshot', ok: true, endedAt: scope.lastCommand.endedAt }) + '\n');
    await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      // Other headed browser fixtures may take focus; keep only this test window visible.
      window.setAlwaysOnTop(true); window.show();
    });
    await window.locator('#preview:not([hidden])').waitFor();
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocusable()), false,
      'preview must never take keyboard focus from the user');
    await electron.evaluate(async ({ BrowserWindow }) => {
      const editor = new BrowserWindow({ width: 320, height: 180, webPreferences: { sandbox: true } });
      await editor.loadURL('data:text/html,<input autofocus value="typing">');
      editor.show(); editor.focus();
    });
    const editor = electron.windows().find(page => page !== window);
    await editor.locator('input').focus();
    await editor.locator('input').evaluate(input => input.setSelectionRange(input.value.length, input.value.length));
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'cmd.start', revision: revision++, scope: scope.key, cmd: 'snapshot' }) + '\n');
    await window.waitForTimeout(100);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('file:')).isFocused()), false);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().startsWith('data:text/html,')), true);
    await editor.keyboard.type('-continues');
    assert.equal(await editor.locator('input').inputValue(), 'typing-continues', 'automatic preview popup preserves ongoing typing');
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('data:text/html,'))?.destroy());
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'cmd.end', revision: revision++, scope: scope.key, cmd: 'snapshot', ok: true, endedAt: scope.lastCommand.endedAt }) + '\n');
    assert.equal(await window.locator('img').count(), 1);
    assert.match(await window.locator('#title').textContent(), /<img/);
    assert.equal(await window.locator('button').count(), 1, 'only the open-page button remains');
    assert.equal(await window.locator('#hide').count(), 0);
    assert.equal(calls[0].identity.sessionId, 'fixture');
    await fs.mkdir(path.join(root, 'artifacts'));
    scope.currentTab.title = '订单工作台';
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'tab.change', revision: revision++, scope: scope.key, tabId: 'target', title: '订单工作台', url: scope.currentTab.url }) + '\n');
    await window.getByRole('heading', { name: '订单工作台' }).waitFor();
    const openPage = window.getByRole('button', { name: '打开当前页面' });
    const pointInside = async (inside) => {
      await electron.evaluate(({ screen, BrowserWindow }, inside) => {
        const bounds = BrowserWindow.getAllWindows()[0].getBounds();
        screen.getCursorScreenPoint = () => ({ x: bounds.x + (inside ? 100 : -20), y: bounds.y + 100 });
      }, inside);
      await window.waitForFunction((inside) => document.body.classList.contains('pointer-inside') === inside, inside);
    };
    await pointInside(false);
    assert.equal(await openPage.evaluate((button) => getComputedStyle(button).opacity), '0');
    // Native cursor tracking works even when drag regions suppress DOM hover.
    await pointInside(true);
    assert.equal(await openPage.evaluate((button) => getComputedStyle(button).opacity), '1');
    assert.equal(await window.locator('body').evaluate(el => getComputedStyle(el).webkitAppRegion), 'no-drag');
    assert.equal(await window.locator('#drag-surface').evaluate(el => getComputedStyle(el).webkitAppRegion), 'no-drag');
    assert.equal(await window.locator('#drag-surface').evaluate(el => getComputedStyle(el).pointerEvents), 'auto');
    assert.equal(await window.locator('header').evaluate(el => getComputedStyle(el).webkitAppRegion), 'no-drag');
    const buttonBounds = await openPage.boundingBox();
    assert.equal(await window.evaluate(({ x, y }) => document.elementFromPoint(x + 16, y + 16).closest('button')?.id, buttonBounds), 'open-page', 'the button must remain above the drag surface');
    assert.equal(await openPage.evaluate(el => getComputedStyle(el).webkitAppRegion), 'no-drag');
    const beforeDrag = await electron.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const area = screen.getDisplayMatching(window.getBounds()).workArea;
      window.setPosition(area.x + 80, area.y + 80);
      return window.getBounds();
    });
    await window.mouse.move(100, 100);
    await window.mouse.down();
    await window.mouse.move(160, 140);
    await window.mouse.up();
    const afterDrag = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.equal(afterDrag.x, beforeDrag.x + 60, 'dragging must move the native window horizontally');
    assert.equal(afterDrag.y, beforeDrag.y + 40, 'dragging must move the native window vertically');
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'cmd.start', revision: revision++, scope: scope.key, cmd: 'snapshot' }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 100));
    const afterCommand = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.equal(afterCommand.x, afterDrag.x, 'a new command must preserve the dragged position');
    assert.equal(afterCommand.y, afterDrag.y);
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'cmd.end', revision: revision++, scope: scope.key, cmd: 'snapshot', ok: true }) + '\n');
    // Command completion schedules one rate-limited preview before the idle check.
    await window.waitForFunction(() => document.getElementById('status').textContent === '操作已完成 · 预览已暂停');
    await pointInside(true);
    assert.equal(calls.filter((call) => call.method === 'use').length, 0, 'hover must not activate the page');
    // Capture may clear synthetic hover in a native Electron window. The next
    // pointer move/click must still be able to hit the action above the preview.
    await window.screenshot();
    await window.mouse.move(-10, -10);
    const idleCaptureCount = calls.filter(call => call.method === '_preview').length;
    await new Promise(resolve => setTimeout(resolve, 1800));
    assert.equal(calls.filter(call => call.method === '_preview').length, idleCaptureCount, 'visible idle preview does not capture repeatedly');
    assert.equal(await openPage.evaluate((button) => getComputedStyle(button).opacity), '1', 'preview refresh must not hide the button while the native pointer stays inside');
    await openPage.click();
    await window.waitForFunction(() => !document.getElementById('open-page').disabled);
    assert.equal(calls.filter((call) => call.method === 'use').length, 1);
    await pointInside(false);
    assert.equal(await openPage.evaluate((button) => getComputedStyle(button).opacity), '0');
    await window.screenshot({ path: path.join(root, 'artifacts/companion.png') });
    // Distinct scopes/pages coexist; exposed portions raise only their own card.
    scopes = [scope, ...['second', 'third'].map(id => ({ ...scope, key: `${id}/${id}`, sessionId: id, taskId: id,
      currentTab: { id, title: id, url: `https://example.test/${id}` } }))];
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'daemon.status', revision: revision++,
      browser: 'connected', scopes, companionAutoShow: true }) + '\n');
    await window.waitForFunction(() => document.querySelectorAll('.card img:not([hidden])').length === 3);
    const card = id => window.locator('.card').filter({ has: window.getByRole('heading', { name: id, exact: true }) });
    const frontAt = async (x, y) => window.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.card')?.getAttribute('aria-label'), { x, y });
    const firstBox = await card('订单工作台').boundingBox();
    const secondBox = await card('second').boundingBox();
    assert.equal(secondBox.x - firstBox.x, 32);
    assert.equal(secondBox.y - firstBox.y, 32);
    await window.mouse.click(8, 8);
    assert.ok(await window.evaluate(() => document.querySelector('.card').getAnimations().length > 0), 'reordering animates instead of jumping');
    await window.evaluate(() => Promise.all([...document.querySelectorAll('.card')].flatMap(el => el.getAnimations().map(animation => animation.finished.catch(() => {})))));
    assert.equal(await frontAt(100, 100), '订单工作台');
    assert.equal((await card('订单工作台').boundingBox()).x, firstBox.x + 64, 'selected card moves into the front stack slot');
    assert.equal((await card('second').boundingBox()).x, firstBox.x, 'other cards shift back in order');
    const zBefore = await card('订单工作台').evaluate(el => el.style.zIndex);
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'cmd.end', revision: revision++, scope: 'third/third', cmd: 'snapshot', ok: true, endedAt: Date.now() }) + '\n');
    await window.waitForTimeout(100);
    assert.equal(await card('订单工作台').evaluate(el => el.style.zIndex), zBefore, 'updates preserve manual stacking order');
    await window.mouse.click(8, 8);
    await window.evaluate(() => Promise.all([...document.querySelectorAll('.card')].flatMap(el => el.getAnimations().map(animation => animation.finished.catch(() => {})))));
    assert.equal(await frontAt(100, 100), 'second');
    assert.equal((await card('second').boundingBox()).x, firstBox.x + 64);
    await window.evaluate(async () => {
      const select = title => [...document.querySelectorAll('.card')].find(el => el.getAttribute('aria-label') === title)
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      select('third');
      await new Promise(resolve => requestAnimationFrame(resolve));
      select('订单工作台'); select('second');
      await Promise.all([...document.querySelectorAll('.card')].flatMap(el => el.getAnimations().map(animation => animation.finished.catch(() => {}))));
    });
    assert.equal(await frontAt(100, 100), 'second', 'rapid reordering finishes with the last selected card in front');
    assert.equal((await card('second').boundingBox()).x, firstBox.x + 64);
    assert.equal(calls.filter(call => call.method === 'use').length, 1, 'raising a card does not activate its browser tab');
    await card('second').getByRole('button').click();
    await window.waitForFunction(() => ![...document.querySelectorAll('.card')].find(el => el.getAttribute('aria-label') === 'second').querySelector('button').disabled);
    assert.equal(calls.filter(call => call.method === 'use').at(-1).params.id, 'second');
    // Finishing one scope removes just its card; finishing the last hides the panel.
    for (const item of scopes.slice(1)) for (const peer of subscribers) peer.write(JSON.stringify({ type: 'tab.change', revision: revision++, scope: item.key, tabId: null, reason: 'finish' }) + '\n');
    await window.waitForFunction(() => document.querySelectorAll('.card').length === 1);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'tab.change', revision: revision++, scope: scope.key, tabId: null, reason: 'finish' }) + '\n');
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'daemon.status', revision: revision++, browser: 'connected', scopes, companionAutoShow: true }) + '\n');
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await window.waitForFunction(() => document.querySelectorAll('.card').length === 3);
    await window.screenshot({ path: path.join(root, 'artifacts/companion-stacked.png') });
    scopes = [scope];
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'daemon.status', revision: revision++, browser: 'connected', scopes }) + '\n');
    await window.waitForFunction(() => document.querySelectorAll('.card').length === 1);
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const countWhileHidden = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(calls.length, countWhileHidden, 'hidden window stops screenshot polling');
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    // Disable via the same daemon preference used by the tray checkbox/CLI.
    autoShow = false;
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'daemon.status', revision: revision++, idleMs: 1000,
      browser: 'connected', scopes, companionAutoShow: false }) + '\n');
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    for (const peer of subscribers) peer.write(JSON.stringify({ type: 'cmd.start', revision: revision++, scope: scope.key, cmd: 'snapshot' }) + '\n');
    await window.waitForTimeout(150);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, 'disabled connection must not reopen the preview');
    // Manual opening remains available while auto-popup is disabled.
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    // Same socket reconnect replaces the snapshot rather than appending scopes.
    scopes = [];
    for (const peer of subscribers) peer.destroy();
    await window.getByRole('heading', { name: '等待浏览器操作' }).waitFor({ state: 'attached' });
    assert.equal(await window.locator('#preview').isVisible(), false);
    assert.equal(await openPage.isDisabled(), true);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, 'disconnect hides the empty panel');
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, 'no target means even manual opening does not display a placeholder');
    // Closing the daemon leaves the observer offline; it never starts a new daemon.
    for (const peer of subscribers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
    await window.getByText('暂无可用预览', { exact: true }).waitFor({ state: 'attached' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(calls.every((call) => ['_preview', 'use'].includes(call.method)));
    t.diagnostic('Companion artifacts: ' + root);
  });
