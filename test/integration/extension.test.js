import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromeExecutable } from '../../src/core/connection.js';
import { EXTENSION_ID, EXTENSION_ORIGIN } from '../../src/extension/constants.js';
import { getConfig } from '../../src/config.js';
import { installationPlan } from '../../src/extension/install.js';
import { rpcCall } from '../../src/daemon/rpc.js';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../../', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
async function until(fn, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(100); }
  throw new Error('condition did not become true');
}

test('actual extension + Chrome native host + daemon + CLI, with no CDP port',
  { skip: !process.env.DT_EXTENSION_INTEGRATION, timeout: 120_000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-ext-e2e-'));
    const stateDir = path.join(root, 'state');
    const testHost = 'com.browser_agent_cli.test_' + randomBytes(6).toString('hex');
    const install = installationPlan({ ...getConfig(), stateDir });
    const manifestPath = path.join(root, 'profile', 'NativeMessagingHosts', testHost + '.json');
    const launcher = path.join(root, 'host.sh');
    await fs.writeFile(launcher, `#!/bin/sh\nexport DT_STATE_DIR=${quote(stateDir)}\nexec ${quote(process.execPath)} ${quote(install.hostPath)} "$@"\n`, { mode: 0o700 });
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify({ name: testHost, description: 'Temporary DT integration fixture',
      path: launcher, type: 'stdio', allowed_origins: [EXTENSION_ORIGIN] }), { flag: 'wx', mode: 0o600 });
    // Only this uniquely named fixture registration is removed; the real host is never overwritten.
    t.after(async () => { await fs.unlink(manifestPath); });
    const extensionDir = path.join(root, 'extension');
    await fs.cp(path.join(project, 'extension'), extensionDir, { recursive: true });
    const workerFile = path.join(extensionDir, 'background.js');
    await fs.writeFile(workerFile, (await fs.readFile(workerFile, 'utf8')).replace("'com.browser_agent_cli.dt'", JSON.stringify(testHost)));
    const received = [];
    const site = http.createServer(async (req, res) => {
      if (req.url === '/api') {
        let body = ''; for await (const bytes of req) body += bytes;
        received.push(body);
        const result = JSON.stringify({ saved: true, value: JSON.parse(body).name });
        res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(result) });
        res.end(result);
      } else if (req.url === '/frame') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<label>Frame input <input name="frame-input"></label><button onclick="this.textContent=\'Clicked\'">Frame save</button>');
      } else {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<!doctype html><title>Existing logged-in tab</title><h1>Extension fixture</h1>' +
          '<label>开发时间 <input name="date" value="2025-03-18"></label>' +
          '<label>Category <select><option value="a">A</option><option value="b">B</option></select></label>' +
          '<div contenteditable="true" aria-label="Editor" role="textbox">Draft</div>' +
          '<button id="save" onclick="save()">保存</button><p id="result"></p><iframe src="/frame"></iframe>' +
          '<script>async function save(){await fetch("/api",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:document.querySelector("input").value})});document.querySelector("#result").textContent="已保存"}</script>');
      }
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    t.after(() => { site.closeAllConnections(); return new Promise((resolve) => site.close(resolve)); });
    const url = `http://127.0.0.1:${site.address().port}`;
    const env = { ...process.env, DT_STATE_DIR: stateDir, DT_SESSION: 'extension-test', DT_TASK: 'edit' };
    const run = async (...args) => {
      const { stdout } = await exec(process.execPath, [path.join(project, 'bin/dt.js'), ...args, '--json'],
        { env, timeout: 30_000, maxBuffer: 8_000_000 });
      return JSON.parse(stdout);
    };
    const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      executablePath: chromeExecutable(), headless: true, args: ['--enable-unsafe-extension-debugging'],
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    t.after(async () => { await run('kill', '--daemon').catch(() => {}); await context.close(); });
    // The debugging pipe is test harness only. CLI/daemon communicate exclusively
    // via the native host; the browser has no remote-debugging-port.
    const page = context.pages()[0];
    await page.goto(url);
    await page.evaluate(() => localStorage.setItem('existing-login', 'fixture-login-state'));
    const control = await context.browser().newBrowserCDPSession();
    assert.equal((await control.send('Extensions.loadUnpacked', { path: extensionDir })).id, EXTENSION_ID);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
    await popup.locator('#connect').click();
    await until(async () => {
      const text = await popup.locator('#status').innerText();
      if (/not found|forbidden|exited/i.test(text)) throw new Error(text);
      return text.includes('已连接');
    });
    const connection = await run('connect', '--extension');
    assert.equal(connection.backend, 'extension');
    const target = connection.tabs.find((tab) => tab.url === url + '/');
    assert.ok(target?.id);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const before = await worker.evaluate(() => chrome.debugger.getTargets());
    assert.equal(before.filter((target) => target.attached && target.extensionId).length, 0);
    await run('use', target.id);
    const previewState = await fs.readFile(path.join(stateDir, 'state.json'), 'utf8');
    const previewScope = JSON.parse(previewState).scopes.find((scope) => scope.key === 'extension-test/edit');
    const preview = await rpcCall(path.join(stateDir, 'daemon.sock'), { jsonrpc: '2.0', id: 801, method: '_preview',
      scope: { sessionId: 'extension-test', taskId: 'edit' }, params: { tabId: target.id, createdAt: previewScope.createdAt } });
    assert.match(preview.result?.image, /^data:image\/jpeg;base64,/);
    assert.equal(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8'), previewState);
    assert.equal((await run('ls', 'get', 'existing-login')).value, 'fixture-login-state');
    const snap = await run('snapshot');
    await fs.writeFile(path.join(root, 'snapshot.json'), JSON.stringify(snap, null, 2));
    assert.doesNotMatch(snap.text, /DT 控制中|关闭 DT/);
    const input = snap.elements.find((element) => element.name.trim() === '开发时间' && element.role === 'textbox');
    assert.ok(input?.ref);
    await run('fill', input.ref, '2026-03-18');
    assert.equal(await page.locator('input[name=date]').inputValue(), '2026-03-18');
    await run('fill', 'role=textbox[name="Editor"]', '文本编辑');
    assert.equal(await page.locator('[contenteditable]').innerText(), '文本编辑');
    await run('select', 'select', 'b');
    await run('type', 'input[name=date]', '!');
    assert.equal(await page.locator('input[name=date]').inputValue(), '2026-03-18!');
    const frameInput = snap.elements.find((element) => element.name.trim() === 'Frame input' && element.role === 'textbox');
    assert.ok(frameInput?.ref);
    await run('fill', frameInput.ref, 'iframe value');
    assert.equal(await page.frameLocator('iframe').locator('input').inputValue(), 'iframe value');
    const frameButton = snap.elements.find((element) => element.name === 'Frame save' && element.role === 'button');
    await run('click', frameButton.ref);
    assert.equal(await page.frameLocator('iframe').locator('button').innerText(), 'Clicked');
    await run('reqclear');
    await run('click', 'role=button[name="保存"]');
    await run('wait', 'text=已保存');
    assert.equal(received.length, 1, 'click was not retried');
    assert.deepEqual(JSON.parse(received[0]), { name: '2026-03-18!' });
    const requests = (await run('reqs', 'method:POST')).requests;
    assert.equal(requests.length, 1); assert.equal(requests[0].status, 201);
    const response = await until(async () => { const result = await run('res', String(requests[0].n)); return result.response.body && result; });
    assert.equal(JSON.parse(response.response.body).saved, true);
    await run('ck', 'set', 'fixture-cookie', 'present');
    assert.equal((await run('ck', 'get', 'fixture-cookie')).cookies[0].value, 'present');
    const screenshot = path.join(root, 'extension.png');
    await run('shot', screenshot);
    assert.ok((await fs.stat(screenshot)).size > 100);
    await assert.rejects(run('kill', '--daemon', '--browser'), /cannot close/);
    await run('use', target.id, '--activate');
    const activeId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    assert.equal(activeId, Number(target.id.split(':').at(-1)));
    await run('new', url + '/?owned');
    assert.equal(await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id), activeId);
    await run('kill');
    assert.ok((await run('tabs')).tabs.some((tab) => tab.id === target.id), 'existing user tab survives scope cleanup');
    await run('use', target.id);
    await run('overlay', 'off');
    await run('reload');
    assert.equal((await run('eval', 'Boolean(document.querySelector("[data-dt-overlay]"))')).result, false);
    await run('goto', url + '/?second');
    await run('back');
    assert.equal((await run('url')).url, url + '/');
    await run('disconnect');
    assert.equal((await run('status')).browser, 'disconnected');
    await run('connect', '--extension');
    await run('use', target.id);
    await popup.locator('#disconnect').click();
    await until(async () => !(await run('status')).extensionAvailable);
    await assert.rejects(run('title'), /not connected/);
    t.diagnostic('Extension fixture artifacts: ' + root);
  });
