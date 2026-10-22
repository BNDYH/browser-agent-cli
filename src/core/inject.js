export async function evaluate(page, expression) {
  const result = await page.evaluate((source) => (0, eval)(source), expression);
  return { ok: true, result };
}

export async function listElements(page, selector) {
  const elements = await (await resolveLocator(page, selector)).evaluateAll((nodes) => nodes.filter((node) => !node.closest('[data-dt-overlay]')).slice(0, 1000).map((node) => ({
    tag: node.tagName.toLowerCase(), id: node.id || undefined, class: node.className || undefined,
    name: node.getAttribute('name') || undefined, type: node.getAttribute('type') || undefined,
    value: 'value' in node ? String(node.value).slice(0, 500) : undefined,
    text: (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500),
  })));
  return { ok: true, selector, count: elements.length, elements };
}

export async function cookies(page, operation, key, value) {
  if (page.send) {
    if (operation === 'set') {
      const result = await page.send('Network.setCookie', { name: key, value, url: page.url() });
      if (result.success === false) throw new Error('Chrome rejected cookie');
      return { ok: true, name: key, set: true };
    }
    const { cookies: all } = await page.send('Network.getCookies', { urls: [page.url()] });
    const matching = all.filter((cookie) => !key || cookie.name === key);
    if (operation === 'get') return { ok: true, cookies: matching };
    for (const cookie of matching) await page.send('Network.deleteCookies', {
      name: cookie.name, domain: cookie.domain, path: cookie.path, ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
    });
    return { ok: true, cleared: true };
  }
  const context = page.context();
  if (operation === 'get') {
    const all = await context.cookies(page.url());
    return { ok: true, cookies: key ? all.filter((cookie) => cookie.name === key) : all };
  }
  if (operation === 'clear') {
    const all = await context.cookies(page.url());
    for (const cookie of all.filter((cookie) => !key || cookie.name === key)) {
      await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
    }
    return { ok: true, cleared: true };
  }
  const url = new URL(page.url());
  await context.addCookies([{ name: key, value, domain: url.hostname, path: '/', secure: url.protocol === 'https:' }]);
  return { ok: true, name: key, set: true };
}

export async function localStorage(page, operation, key, value) {
  const result = await page.evaluate(({ operation: op, key: name, value: content }) => {
    if (op === 'get') return name ? window.localStorage.getItem(name) : { ...window.localStorage };
    window.localStorage.setItem(name, content);
    return true;
  }, { operation, key, value });
  return { ok: true, ...(operation === 'get' ? { value: result } : { name: key, set: true }) };
}
import { resolveLocator } from './actions.js';
