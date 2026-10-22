import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NativeDecoder, nativeFrame } from '../../src/extension/framing.js';
import { ExtensionBridge } from '../../src/extension/bridge.js';
import { EXTENSION_ID } from '../../src/extension/constants.js';
import { installationPlan, installNativeHost } from '../../src/extension/install.js';
import { getConfig } from '../../src/config.js';
import { parseArgv, toRpcCommand } from '../../src/cli/parser.js';

test('native framing handles partial length/data, multibyte text and multiple messages', () => {
  const values = [];
  const decoder = new NativeDecoder((value) => values.push(value));
  const bytes = Buffer.concat([nativeFrame({ text: '中文\n日期' }), nativeFrame({ id: 2 })]);
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  assert.deepEqual(values, [{ text: '中文\n日期' }, { id: 2 }]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(100);
  assert.throws(() => new NativeDecoder(() => {}, 10).push(oversized), /size/);
});

class Socket extends EventEmitter {
  constructor() { super(); this.sent = []; this.destroyed = false; this.writableLength = 0; }
  write(line) { this.sent.push(JSON.parse(line)); }
  end(line) { if (line) this.write(line); this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}
const hello = { protocol: 1, extensionId: EXTENSION_ID, browserId: 'test-browser' };
test('bridge rejects a wrong extension and a second browser; correlates responses', async () => {
  const bridge = new ExtensionBridge();
  const bad = new Socket(); bridge.accept(bad, { ...hello, extensionId: 'wrong' });
  assert.equal(bad.destroyed, true);
  const peer = new Socket(); bridge.accept(peer, hello);
  const other = new Socket(); bridge.accept(other, hello);
  assert.equal(other.destroyed, true);
  const a = bridge.call('tabs.get', { tabId: 1 });
  const b = bridge.call('tabs.get', { tabId: 2 });
  const commands = peer.sent.filter((msg) => msg.type === 'command');
  peer.emit('data', JSON.stringify({ type: 'response', id: commands[1].id, result: { id: 2 } }) + '\n');
  peer.emit('data', JSON.stringify({ type: 'response', id: commands[0].id, result: { id: 1 } }) + '\n');
  assert.deepEqual(await a, { id: 1 }); assert.deepEqual(await b, { id: 2 });
  const c = bridge.call('debug.send'); peer.destroy();
  await assert.rejects(c, /disconnected/);
});
test('extension command timeout terminates the transport instead of releasing an unsafe lease', async () => {
  const bridge = new ExtensionBridge(); const peer = new Socket(); bridge.accept(peer, hello);
  await assert.rejects(bridge.call('debug.send', {}, 5), /timed out/);
  assert.equal(peer.destroyed, true);
  assert.equal(bridge.pending.size, 0);
});
test('installer pins origin and produces executable host launcher with safely quoted paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dt-install-'"));
  const config = { ...getConfig(), stateDir: path.join(root, 'state'), shotsDir: path.join(root, 'state/shots') };
  const plan = installationPlan(config, { home: root, platform: 'darwin' });
  assert.equal(fs.existsSync(plan.manifestPath), false, 'info is read-only');
  installNativeHost(config, { home: root, platform: 'darwin' });
  const manifest = JSON.parse(fs.readFileSync(plan.manifestPath, 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.equal(manifest.path, plan.launcherPath);
  assert.equal(fs.statSync(plan.launcherPath).mode & 0o777, 0o700);
  const extension = JSON.parse(fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url)));
  const id = createHash('sha256').update(Buffer.from(extension.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (char) => String.fromCharCode(97 + parseInt(char, 16)));
  assert.equal(id, EXTENSION_ID);
  assert.equal(extension.host_permissions, undefined);
  assert.equal(extension.content_scripts, undefined);
  assert.equal(extension.externally_connectable, undefined);
});
test('connect --extension cannot accidentally specify a CDP endpoint', () => {
  assert.equal(toRpcCommand(parseArgv(['connect', '--extension']))[1].extension, true);
  assert.throws(() => toRpcCommand(parseArgv(['connect', '--extension', '9222'])));
  assert.throws(() => toRpcCommand(parseArgv(['connect', '--extension', '--port', '9222'])));
});
