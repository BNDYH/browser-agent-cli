import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const directory = fileURLToPath(new URL('../../companion/', import.meta.url));

// The preview is optional; a missing desktop runtime must not break CLI commands.
export function ensureCompanion(config) {
  if (process.platform !== 'darwin' || process.env.DT_COMPANION === '0') return;
  try {
    const pid = Number(fs.readFileSync(path.join(config.stateDir, 'companion.pid'), 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return; } catch (error) { if (error.code === 'EPERM') return; }
    }
  } catch {}
  try {
    const electron = createRequire(path.join(directory, 'package.json'))('electron');
    const log = fs.openSync(path.join(config.stateDir, 'companion.log'), 'a', 0o600);
    try {
      const env = { ...process.env, DT_STATE_DIR: config.stateDir };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [directory], { detached: true, stdio: ['ignore', log, log], env });
      child.on('error', () => {});
      child.unref();
    } finally { fs.closeSync(log); }
  } catch {} // Source-only/server installations can run without Electron.
}
