// Deliberately exclude query, fragment, credentials and non-web URL payloads.
export function eventUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'about:'].includes(url.protocol)) return url.protocol;
    url.search = ''; url.hash = ''; url.username = ''; url.password = '';
    return url.href;
  } catch { return ''; }
}

export function eventRequest(item) {
  return { n: item.n, tabId: item.tabId, method: item.method, url: eventUrl(item.url),
    status: item.status, ms: item.ms, resourceType: item.resourceType,
    ...(item.failure ? { failed: true } : {}) };
}
