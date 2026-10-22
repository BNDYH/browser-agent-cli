import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function numberFromEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function expandHome(value) {
  if (value === '~') return os.homedir();
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

export function getConfig() {
  const stateDir = path.resolve(expandHome(process.env.DT_STATE_DIR || '~/.dt'));
  return {
    stateDir,
    socketPath: path.join(stateDir, 'daemon.sock'),
    statePath: path.join(stateDir, 'state.json'),
    sessionPath: path.join(stateDir, 'client-session'),
    auditPath: path.join(stateDir, 'audit.log'),
    logPath: path.join(stateDir, 'daemon.log'),
    shotsDir: path.join(stateDir, 'shots'),
    port: numberFromEnv('DT_PORT', 9222),
    profileDir: expandHome(process.env.DT_PROFILE || '~/.dt-chrome'),
    idleTimeoutMs: numberFromEnv('DT_IDLE_TIMEOUT_MS', 1_800_000),
    requestCacheSize: numberFromEnv('DT_REQ_CACHE', 500),
    waitTimeoutMs: numberFromEnv('DT_WAIT_TIMEOUT', 10_000),
    lockTtlMs: numberFromEnv('DT_LOCK_TTL_MS', 30_000),
  };
}

export function ensureStateDir(config = getConfig()) {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.shotsDir, { recursive: true, mode: 0o700 });
}

export function defaultSessionId(config = getConfig()) {
  ensureStateDir(config);
  try {
    const existing = fs.readFileSync(config.sessionPath, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const id = `local-${crypto.randomBytes(6).toString('hex')}`;
  const temporary = `${config.sessionPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${id}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(temporary, config.sessionPath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return fs.readFileSync(config.sessionPath, 'utf8').trim();
  } finally {
    fs.unlinkSync(temporary);
  }
  return id;
}
