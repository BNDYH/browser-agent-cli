import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { rpcCall } from '../../src/daemon/rpc.js';
import { chromium } from 'playwright-core';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/dt.js', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await pause(50); }
  throw new Error('condition did not become true');
}

test('real Chrome: CLI, scopes, AX refs, capture, restart and shutdown', { skip: !process.env.DT_INTEGRATION, timeout: 120_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-e2e-'));
  const state = path.join(root, 'state');
  const socket = path.join(state, 'daemon.sock');
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const chromePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const site = http.createServer((req, res) => {
    if (req.url === '/api') {
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'set-cookie': 'server-secret=secret' });
      res.end(body);
    } else if (req.url === '/frame') {
      res.end('<button aria-label="Frame action">Frame</button>');
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>DT Fixture</title><h1>Form</h1><p id="name-label">Full name</p>' +
        '<input aria-labelledby="name-label" name="name"><button id="load">Load</button>' +
        '<div id="result"></div><select name="category"><option value="a">A</option><option value="b">B</option></select>' +
        '<iframe src="/frame"></iframe><script>document.querySelector("#load").onclick=async()=>{' +
        'await fetch("/api",{method:"POST",headers:{Authorization:"Bearer test-secret"},body:"fixture"});' +
        'document.querySelector("#result").textContent="Loaded";};</script>');
    }
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}`;
  const env = { ...process.env, DT_STATE_DIR: state, DT_PORT: String(chromePort),
    DT_PROFILE: path.join(root, 'profile'), DT_SESSION: 'test', DT_TASK: 'one', DT_LOCK_TTL_MS: '60' };
  let browserLaunched = false;
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args, '--json'], { env, timeout: 30_000, maxBuffer: 4_000_000 });
    return JSON.parse(stdout);
  };
  t.after(async () => {
    if (browserLaunched) await run('kill', '--daemon', '--browser').catch(() => {});
    else await run('kill', '--daemon').catch(() => {});
    await new Promise((resolve) => site.close(resolve));
    t.diagnostic('Fixture artifacts: ' + root);
  });

  const statuses = await Promise.all(Array.from({ length: 5 }, () => run('status')));
  assert.equal(new Set(statuses.map((status) => status.pid)).size, 1, 'concurrent CLI startup creates one daemon');
  const launched = await run('launch', '--headless');
  browserLaunched = true;
  assert.equal(launched.endpoint, `http://127.0.0.1:${chromePort}`);
  const events = [];
  const subscriber = net.createConnection(socket);
  subscriber.on('error', () => {});
  let eventBuffer = '';
  subscriber.on('data', (data) => {
    eventBuffer += data;
    let end;
    while ((end = eventBuffer.indexOf('\n')) >= 0) {
      events.push(JSON.parse(eventBuffer.slice(0, end))); eventBuffer = eventBuffer.slice(end + 1);
    }
  });
  await new Promise((resolve) => subscriber.once('connect', resolve));
  subscriber.write('{"jsonrpc":"2.0","id":900,"method":"_subscribe"}\n');
  t.after(() => subscriber.destroy());
  await until(() => events.some((event) => event.type === 'daemon.status'));
  assert.equal((await run('goto', url)).title, 'DT Fixture');
  const firstTab = (await run('status')).currentTab.id;
  // A separate CDP client simulates changes outside dt's command dispatcher.
  const observer = await chromium.connectOverCDP(launched.endpoint);
  t.after(() => observer.close());
  const observed = observer.contexts()[0].pages().find((page) => page.url() === url + '/');
  assert.equal(await observed.locator('[data-dt-overlay]').count(), 0, 'successful command releases visual control');
  await observed.locator('input').fill('keep-this-draft');
  const reused = await run('open', url, '--session', 'reuse-session');
  assert.equal(reused.tab.id, firstTab, 'open reuses another idle session page');
  assert.equal(await observed.locator('input').inputValue(), 'keep-this-draft', 'reuse must not reload form state');
  await run('finish', '--session', 'reuse-session');
  assert.equal((await run('status', '--session', 'reuse-session')).currentTab, null);
  assert.equal(observed.isClosed(), false, 'finish preserves the reusable browser page');
  await observed.goto(url + '/?event-secret#private');
  await until(() => events.some((event) => event.type === 'tab.change' && event.url === url + '/'));
  await run('goto', url);
  const created = await Promise.all(['parallel-a', 'parallel-b'].map((task) => run('new', 'about:blank', '--task', task)));
  assert.notEqual(created[0].tab.id, created[1].tab.id, 'parallel background targets remain distinct');
  for (const task of ['parallel-a', 'parallel-b']) await run('kill', '--task', task);
  const script = path.join(root, 'throw.mjs');
  await fs.writeFile(script, 'export default async function () { throw new Error("script-fixture-secret"); }\n');
  await assert.rejects(run('run', script), (error) => {
    const result = JSON.parse(error.stderr);
    assert.match(result.error.data.stack, /throw\.mjs(?:\?t=\d+)?:1:/); return true;
  });
  assert.equal(await observed.locator('[data-dt-overlay]').count(), 0, 'failed command also releases visual control');
  await assert.rejects(exec(process.execPath, [cli, 'wait', '#not-present', '--timeout', '100'], { env }), (error) => {
    assert.match(error.stderr, /selector: #not-present/); assert.match(error.stderr, /title: DT Fixture/); return true;
  });
  const snapshot = await run('snapshot');
  const beforePreview = await fs.readFile(path.join(state, 'state.json'), 'utf8');
  const previewScope = JSON.parse(beforePreview).scopes.find((s) => s.key === 'test/one');
  const preview = await rpcCall(socket, { jsonrpc: '2.0', id: 800, method: '_preview',
    params: { tabId: firstTab, createdAt: previewScope.createdAt }, scope: { sessionId: 'test', taskId: 'one' } });
  assert.match(preview.result.image, /^data:image\/jpeg;base64,/);
  assert.ok(preview.result.image.length > 1000);
  assert.equal(await fs.readFile(path.join(state, 'state.json'), 'utf8'), beforePreview, 'preview does not persist or refresh activity');
  assert.match(snapshot.text, /Form/);
  assert.doesNotMatch(snapshot.text, /DT 控制|关闭 DT/);
  const textbox = snapshot.elements.find((item) => item.role === 'textbox' && item.name === 'Full name');
  assert.ok(textbox?.ref, 'AX accessible name resolves aria-labelledby');
  assert.equal(snapshot.elements.find((item) => item.role === 'option' && item.name === 'B').value, 'b');
  const frameButton = snapshot.elements.find((item) => item.name === 'Frame action' && item.role === 'button');
  assert.ok(frameButton?.ref);
  await run('click', frameButton.ref);
  await run('fill', textbox.ref, 'fixture-input-secret');
  assert.equal((await run('eval', 'document.querySelector("input").value')).result, 'fixture-input-secret');
  await run('type', textbox.ref, '!');
  await run('select', 'select', 'b');
  await run('ls', 'set', 'fixture-key', 'storage-secret');
  assert.equal((await run('ls', 'get', 'fixture-key')).value, 'storage-secret');
  await run('ck', 'set', 'fixture-cookie', 'cookie-secret');
  assert.equal((await run('ck', 'get', 'fixture-cookie')).cookies[0].value, 'cookie-secret');
  await run('reqclear');
  await run('click', '#load');
  await run('wait', 'text=Loaded');
  const requests = await until(async () => {
    const result = await run('reqs', 'method:POST');
    return result.requests[0]?.status === 200 ? result.requests : null;
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requestHeaders, undefined);
  const n = requests[0].n;
  assert.equal((await run('req', String(n))).request.headers.authorization, '<redacted>');
  const response = await until(async () => { const r = await run('res', String(n)); return r.response.body ? r : null; });
  assert.equal(JSON.parse(response.response.body).ok, true);
  const harFile = path.join(root, 'capture.har');
  await run('har', harFile);
  assert.doesNotMatch(await fs.readFile(harFile, 'utf8'), /Bearer test-secret|server-secret=secret/);
  const shot = path.join(root, 'shot.png');
  await run('shot', shot);
  assert.ok((await fs.stat(shot)).size > 100);
  await run('overlay', 'off');
  await run('reload');
  assert.equal((await run('eval', 'Boolean(document.querySelector("[data-dt-overlay]"))')).result, false);
  await run('goto', url + '/?second');
  await run('back');
  assert.equal((await run('url')).url, url + '/');

  await run('goto', url, '--task', 'two');
  assert.notEqual((await run('status', '--task', 'two')).currentTab.id, firstTab);
  assert.equal((await run('reqs', 'method:POST', '--task', 'two')).requests.length, 0);
  await run('use', firstTab, '--task', 'two');
  await run('overlay', 'on');
  const idleStatus = await run('status');
  assert.equal(idleStatus.controlling, false);
  assert.equal(idleStatus.browser, 'connected');
  const busy = rpcCall(socket, { jsonrpc: '2.0', id: 12, method: 'waitms', params: { ms: 800 }, scope: { sessionId: 'test', taskId: 'one' } });
  await pause(200); // Beyond the 60ms lease: the executing command must renew it.
  assert.equal(await observed.locator('[data-dt-overlay]').count(), 1, 'control indicator exists only while executing');
  const busySnapshot = await new Promise((resolve, reject) => {
    const peer = net.createConnection(socket);
    peer.on('error', reject);
    let buffer = '';
    peer.on('connect', () => peer.write('{"jsonrpc":"2.0","id":901,"method":"_subscribe"}\n'));
    peer.on('data', (chunk) => { buffer += chunk; if (buffer.includes('\n')) { resolve(JSON.parse(buffer.split('\n')[0])); peer.destroy(); } });
  });
  assert.equal(busySnapshot.scopes.find((s) => s.key === 'test/one').currentCommand.cmd, 'waitms');
  const blockedPreview = await rpcCall(socket, { jsonrpc: '2.0', id: 801, method: '_preview',
    params: { tabId: firstTab, createdAt: previewScope.createdAt }, scope: { sessionId: 'test', taskId: 'one' } });
  assert.equal(blockedPreview.error.code, -32003);
  const conflict = await rpcCall(socket, { jsonrpc: '2.0', id: 13, method: 'fill', params: { selector: 'input', text: 'collision' }, scope: { sessionId: 'test', taskId: 'two' } });
  assert.equal(conflict.error?.code, -32003);
  const activationConflict = await rpcCall(socket, { jsonrpc: '2.0', id: 14, method: 'use', params: { id: firstTab, activate: true }, scope: { sessionId: 'test', taskId: 'two' } });
  assert.equal(activationConflict.error?.code, -32003);
  await busy;
  assert.equal(await observed.locator('[data-dt-overlay]').count(), 0);
  const completedStatus = await run('status');
  assert.equal(completedStatus.controlling, false);
  assert.equal(completedStatus.browser, 'connected');
  assert.equal(completedStatus.pid, idleStatus.pid, 'completion retains the daemon connection');
  assert.equal(completedStatus.currentTab.id, firstTab);
  await run('use', firstTab, '--activate');
  await run('fill', 'input', 'restored');
  await run('kill', '--daemon');
  await until(async () => { try { await fs.stat(socket); return false; } catch { return true; } });
  assert.equal((await run('status')).currentTab.id, firstTab);
  assert.equal((await run('eval', 'document.querySelector("input").value')).result, 'restored');
  await run('disconnect');
  assert.equal((await run('status')).browser, 'disconnected');
  await run('connect', String(chromePort));
  assert.equal((await run('status')).currentTab.id, firstTab);
  assert.equal((await run('kill', '--task', 'two')).closedTabs, 1);
  assert.equal((await run('status')).currentTab.id, firstTab, 'killing shared-tab user preserves the owned tab');
  const audit = await fs.readFile(path.join(state, 'audit.log'), 'utf8');
  assert.doesNotMatch(audit, /fixture-input-secret|storage-secret|cookie-secret|document\.querySelector|script-fixture-secret/);
  assert.doesNotMatch(JSON.stringify(events), /event-secret|script-fixture-secret/);
  // A shared page closed by the user must clear both current targets.
  const closing = await run('new', url, '--task', 'closing');
  await run('use', closing.tab.id, '--task', 'watcher');
  const externalPage = observer.contexts()[0].pages().find((page) => page !== observed && page.url() === url + '/');
  await externalPage.close();
  await until(async () => !(await run('status', '--task', 'closing')).currentTab);
  assert.equal((await run('status', '--task', 'watcher')).currentTab, null);
  await run('kill', '--daemon', '--browser');
  browserLaunched = false;
});
