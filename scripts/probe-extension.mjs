import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { chromeExecutable } from '../src/core/connection.js';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-ext-probe-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: chromeExecutable(), headless: true,
  args: ['--enable-unsafe-extension-debugging'],
});
try {
  const session = await context.browser().newBrowserCDPSession();
  const result = await session.send('Extensions.loadUnpacked', { path: fileURLToPath(new URL('../extension', import.meta.url)) });
  console.log(JSON.stringify(result));
} finally { await context.close(); }
