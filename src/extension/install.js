import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStateDir, getConfig } from '../config.js';
import { HOST_NAME, EXTENSION_ID, EXTENSION_ORIGIN } from './constants.js';

export function installationPlan(config = getConfig(), { home = os.homedir(), platform = process.platform } = {}) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error('native host setup currently supports macOS and Linux');
  const directory = platform === 'darwin' ? path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
    : path.join(home, '.config/google-chrome/NativeMessagingHosts');
  return {
    extensionId: EXTENSION_ID,
    extensionPath: fileURLToPath(new URL('../../extension/', import.meta.url)),
    manifestPath: path.join(directory, HOST_NAME + '.json'),
    launcherPath: path.join(config.stateDir, 'native-host.sh'),
    hostPath: fileURLToPath(new URL('./native-host.js', import.meta.url)),
    stateDir: config.stateDir,
  };
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export function installNativeHost(config = getConfig(), options) {
  const plan = installationPlan(config, options);
  ensureStateDir(config);
  const launcher = `#!/bin/sh\nexport DT_STATE_DIR=${quote(config.stateDir)}\nexec ${quote(process.execPath)} ${quote(plan.hostPath)} "$@"\n`;
  fs.writeFileSync(plan.launcherPath, launcher, { mode: 0o700 });
  fs.chmodSync(plan.launcherPath, 0o700);
  fs.mkdirSync(path.dirname(plan.manifestPath), { recursive: true });
  fs.writeFileSync(plan.manifestPath, JSON.stringify({ name: HOST_NAME,
    description: 'Local native bridge for dt Chrome extension', path: plan.launcherPath,
    type: 'stdio', allowed_origins: [EXTENSION_ORIGIN] }, null, 2) + '\n', { mode: 0o600 });
  return { ok: true, ...plan, next: 'Load extensionPath at chrome://extensions, then click Connect in DT Browser Bridge and run dt connect --extension.' };
}
