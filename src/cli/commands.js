import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSessionId, ensureStateDir, getConfig, expandHome } from '../config.js';
import { DtError } from '../errors.js';
import { rpcCall } from '../daemon/rpc.js';
import { scopeKey } from '../core/scopes.js';
import { parseArgv, toRpcCommand } from './parser.js';
import { ensureCompanion } from './companion.js';

const DAEMON_FILE = fileURLToPath(new URL('../daemon/daemon.js', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function daemonAvailable(socketPath) {
  try {
    const response = await rpcCall(socketPath, { jsonrpc: '2.0', id: 0, method: '_ping' }, 1000);
    return Boolean(response.result?.ok);
  } catch (error) {
    if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) return false;
    // A slow/unresponsive daemon is not proof that its socket is stale.
    throw error;
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function ensureDaemon(config = getConfig()) {
  ensureStateDir(config);
  if (Buffer.byteLength(config.socketPath) > 100) throw new DtError('DT_STATE_DIR is too long for a Unix socket');
  if (await daemonAvailable(config.socketPath)) return;
  const lock = path.join(config.stateDir, 'startup.lock');
  const pidFile = path.join(lock, 'pid');
  const deadline = Date.now() + 20_000;
  let locked = false;
  while (!locked && Date.now() < deadline) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      locked = true;
      fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await daemonAvailable(config.socketPath)) return;
      let pid;
      try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch {}
      let old = false;
      try { old = Date.now() - fs.statSync(lock).mtimeMs > 10_000; } catch {}
      if ((pid && !alive(pid)) || (!pid && old)) {
        try { fs.unlinkSync(pidFile); } catch {}
        try { fs.rmdirSync(lock); } catch {}
      }
      await delay(100);
    }
  }
  if (!locked) throw new DtError('daemon startup is already in progress; retry shortly');
  try {
    if (await daemonAvailable(config.socketPath)) return;
    try { fs.unlinkSync(config.socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const log = fs.openSync(config.logPath, 'a', 0o600);
    const child = spawn(process.execPath, [DAEMON_FILE], {
      detached: true, stdio: ['ignore', log, log], env: { ...process.env, DT_STATE_DIR: config.stateDir },
    });
    fs.closeSync(log);
    let spawnError;
    child.on('error', (error) => { spawnError = error; });
    child.unref();
    while (Date.now() < deadline && !spawnError) {
      if (await daemonAvailable(config.socketPath)) return;
      await delay(100);
    }
    throw new DtError(spawnError?.message || `daemon failed to start; see ${config.logPath}`);
  } finally {
    try { fs.unlinkSync(pidFile); } catch {}
    try { fs.rmdirSync(lock); } catch {}
  }
}

export function resolveScope(parsed, config = getConfig(), defaults = {}) {
  const sessionOptionIsKillTarget = parsed.command === 'kill' && parsed.options.session !== undefined;
  const scope = {
    sessionId: (!sessionOptionIsKillTarget && parsed.options.session) || defaults.session || process.env.DT_SESSION || defaultSessionId(config),
    taskId: parsed.options.task || defaults.task || process.env.DT_TASK || 'default',
  };
  scopeKey(scope);
  return scope;
}

export async function execute(argv, config = getConfig(), defaults = {}) {
  const parsed = parseArgv(argv);
  const [method, params] = toRpcCommand(parsed);
  const scope = resolveScope(parsed, config, defaults);
  // Resolve paths in the caller's directory, not the persistent daemon's working directory.
  for (const key of ['file', 'profile']) if (params[key]) params[key] = path.resolve(expandHome(params[key]));
  await ensureDaemon(config);
  const response = await rpcCall(config.socketPath,
    { jsonrpc: '2.0', id: Date.now(), method, params, scope },
    Math.max(30_000, Number(params.ms ?? params.timeout ?? config.waitTimeoutMs) + 15_000));
  if (response.error) throw new DtError(response.error.message, response.error.code, response.error.data);
  if (!params.headless && !['kill', 'status', 'disconnect', 'finish'].includes(method)) {
    const preference = method === 'companion' ? response : await rpcCall(config.socketPath,
      { jsonrpc: '2.0', id: Date.now(), method: 'companion', params: {}, scope });
    if (preference.result?.autoShow) ensureCompanion(config);
  }
  return { result: response.result, json: Boolean(parsed.options.json || defaults.json) };
}

export function formatHuman(result) {
  if (result == null) return '';
  if (typeof result.text === 'string') return result.text;
  const keys = Object.keys(result);
  if (keys.length === 2 && result.ok === true) {
    const key = keys.find((item) => item !== 'ok');
    if (typeof result[key] === 'string') return result[key];
  }
  return JSON.stringify(result, null, 2);
}

export function printResult(output) {
  process.stdout.write((output.json ? JSON.stringify(output.result) : formatHuman(output.result)) + '\n');
}

export function installSkill() {
  const source = fileURLToPath(new URL('../../skills/browser-control/SKILL.md', import.meta.url));
  const destination = path.join(os.homedir(), '.claude/skills/browser-control/SKILL.md');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return { ok: true, file: destination };
}
