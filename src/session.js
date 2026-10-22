import fs from 'node:fs';
import { ensureStateDir, getConfig } from './config.js';

export function readState(config = getConfig()) {
  try {
    return JSON.parse(fs.readFileSync(config.statePath, 'utf8'));
  } catch {
    return { version: 1 };
  }
}

export function writeState(state, config = getConfig()) {
  ensureStateDir(config);
  const temp = `${config.statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, config.statePath);
}
