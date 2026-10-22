import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { rpcCall } from '../../src/daemon/rpc.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/dt.js', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('daemon survives malformed RPC, recovers from crash, streams events and exits idle',
  { skip: !process.env.DT_INTEGRATION, timeout: 30_000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-rpc-'));
    const socketPath = path.join(root, 'daemon.sock');
    const env = { ...process.env, DT_STATE_DIR: root, DT_IDLE_TIMEOUT_MS: '3000' };
    delete env.DT_SESSION;
    delete env.DT_TASK;
    const run = async (...args) => {
      const { stdout } = await exec(process.execPath, [cli, ...args, '--json'], { env, timeout: 10_000 });
      return JSON.parse(stdout);
    };
    t.after(async () => { await run('kill', '--daemon').catch(() => {}); });
    const statuses = await Promise.all(Array.from({ length: 8 }, () => run('status')));
    assert.equal(new Set(statuses.map((s) => s.pid)).size, 1);
    assert.equal(new Set(statuses.map((s) => s.scope)).size, 1);
    const repl = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'repl', '--session', 'A', '--task', 'B', '--json'], { env });
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end('status\nreqclear\nreqclear --session C\nkill --session C\nstatus --session C\nstatus --session D --task E\nunknown\nstatus\nkill --session\nquit\n');
    });
    assert.equal(repl.code, 0);
    const replies = repl.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(replies[0].scope, 'A/B');
    assert.equal(replies[3].clearedScopes, 1);
    assert.equal(replies[4].scope, 'C/B');
    assert.equal(replies[5].scope, 'D/E');
    assert.equal(replies[6].scope, 'A/B');
    assert.equal(replies[7].clearedScopes, 1);
    assert.equal(JSON.parse(repl.stderr).error.code, -32601);
    const malformed = await new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.on('error', reject);
      socket.on('connect', () => socket.write('{invalid}\n'));
      socket.on('data', (bytes) => { resolve(JSON.parse(bytes)); socket.destroy(); });
    });
    assert.equal(malformed.error.code, -32700);
    const rejected = await rpcCall(socketPath, { jsonrpc: '2.0', id: 1, method: 'ck.unknown', scope: { sessionId: 'a', taskId: 'b' } });
    assert.equal(rejected.error.code, -32601);
    // This PID belongs to the daemon created by this fixture, not a user browser.
    process.kill(statuses[0].pid, 'SIGKILL');
    await pause(100);
    const recovered = await run('status');
    assert.notEqual(recovered.pid, statuses[0].pid);
    assert.equal(recovered.scope, statuses[0].scope);
    const events = [];
    const subscriber = net.createConnection(socketPath);
    t.after(() => subscriber.destroy());
    subscriber.on('error', () => {});
    let buffer = '';
    subscriber.on('data', (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        events.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    await new Promise((resolve) => subscriber.once('connect', resolve));
    subscriber.write('{"jsonrpc":"2.0","id":2,"method":"_subscribe"}\n');
    await run('reqclear');
    await pause(50);
    assert.ok(events.some((event) => event.type === 'scope.create'));
    assert.ok(events.some((event) => event.type === 'cmd.end'));
    assert.ok(events.every((event) => !Object.hasOwn(event, 'args')));
    // Read-only status and a live subscriber must not reset the idle deadline.
    let stopped = false;
    for (let i = 0; i < 45; i++) {
      try {
        await rpcCall(socketPath, { jsonrpc: '2.0', id: i + 10, method: 'status', scope: { sessionId: 'a', taskId: 'b' } }, 1000);
      } catch { stopped = true; break; }
      await pause(100);
    }
    assert.equal(stopped, true);
  });
