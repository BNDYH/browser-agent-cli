export async function navigation(page, kind, value, timeout = 10_000) {
  const started = Date.now();
  if (kind === 'goto') await page.goto(value, { waitUntil: 'domcontentloaded', timeout });
  else if (kind === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout });
  // Back/forward cache restores can commit without firing DOMContentLoaded again.
  else if (kind === 'back') await page.goBack({ waitUntil: 'commit', timeout });
  return { ok: true, url: page.url(), title: await page.title(), loadedMs: Date.now() - started };
}

export async function resolveLocator(page, selector) {
  if (/^\[data-dt-ref="dt-snapshot-[a-f0-9]+-\d+"\]$/.test(selector)) {
    for (const frame of page.frames()) {
      const locator = frame.locator(selector);
      if (await locator.count()) return locator;
    }
  }
  return page.locator(selector);
}

export async function act(page, method, params, defaultTimeout) {
  const locator = params.selector ? await resolveLocator(page, params.selector) : null;
  const timeout = params.timeout ?? defaultTimeout;
  if (method === 'click' || method === 'dblclick') await locator[method]({ timeout });
  else if (method === 'type') await locator.pressSequentially(params.text, { delay: params.delay ?? 50, timeout });
  else if (method === 'fill') await locator.fill(params.text, { timeout });
  else if (method === 'select') await locator.selectOption(params.value, { timeout });
  else if (method === 'wait') await locator.waitFor({ state: 'visible', timeout });
  else if (method === 'waitms') await page.waitForTimeout(params.ms);
  return { ok: true, action: method, ...(params.selector ? { selector: params.selector } : {}) };
}
