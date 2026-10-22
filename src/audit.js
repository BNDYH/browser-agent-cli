import fs from 'node:fs';
import { ensureStateDir } from './config.js';

// Persist metadata only. Command args, JavaScript, input values, cookies, query strings
// and result bodies may contain credentials and must not reach audit/event logs.
export function audit(config, scope, command, params, result) {
  ensureStateDir(config);
  const entry = { ts: new Date().toISOString(), scope: scope.key, command,
    ok: Boolean(result?.ok), tabId: scope.currentTabId || undefined };
  fs.appendFileSync(config.auditPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
}
