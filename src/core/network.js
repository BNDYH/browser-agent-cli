const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);
const BODY_LIMIT = 65_536;

export function redactHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key,
    SENSITIVE_HEADERS.has(key.toLowerCase()) ? '<redacted>' : value]));
}

export function filterRequests(requests, filter) {
  if (!filter) return requests;
  const method = /^method:(.+)$/i.exec(filter);
  return requests.filter((request) => method
    ? request.method.toLowerCase() === method[1].toLowerCase() : request.url.includes(filter));
}

export function queryParams(url) {
  try { return [...new URL(url).searchParams].map(([name, value]) => ({ name, value })); }
  catch { return []; }
}

export function requestSummary(item) {
  return { n: item.n, tabId: item.tabId, method: item.method, url: item.url, status: item.status,
    ms: item.ms, resourceType: item.resourceType, ...(item.failure ? { failure: item.failure } : {}) };
}

export function toHar(requests, { redact = true } = {}) {
  const headers = (values) => Object.entries(redact ? redactHeaders(values) : values || {})
    .map(([name, value]) => ({ name, value }));
  return { log: { version: '1.2', creator: { name: 'browser-agent-cli', version: '0.1.0' },
    entries: requests.map((item) => ({
      startedDateTime: item.startedAt, time: item.ms ?? 0,
      request: { method: item.method, url: item.url, httpVersion: 'HTTP/1.1',
        headers: headers(item.requestHeaders), queryString: queryParams(item.url), cookies: [],
        headersSize: -1, bodySize: item.postData ? Buffer.byteLength(item.postData) : 0,
        ...(item.postData ? { postData: { mimeType: item.requestHeaders?.['content-type'] || '', text: item.postData } } : {}) },
      response: { status: item.status || 0, statusText: item.statusText || '', httpVersion: 'HTTP/1.1',
        headers: headers(item.responseHeaders), cookies: [],
        content: { size: item.bodySize ?? 0, mimeType: item.responseHeaders?.['content-type'] || '',
          ...(item.body != null ? { text: item.body } : {}),
          ...(item.bodyOmitted ? { comment: item.bodyOmitted } : {}) },
        redirectURL: item.responseHeaders?.location || '', headersSize: -1, bodySize: item.bodySize ?? -1 },
      cache: {}, timings: { send: 0, wait: item.ms ?? 0, receive: 0 },
      ...(item.failure ? { _failure: item.failure } : {}),
    })),
  } };
}

export class NetworkCapture {
  constructor(scopeStore, maxSize = 500, onEvent = () => {}) {
    this.scopeStore = scopeStore;
    this.maxSize = maxSize;
    this.onEvent = onEvent;
    this.pageIds = new WeakMap();
    this.requestRecords = new WeakMap();
    this.responseJobs = new WeakMap();
    this.nextNumber = 1;
  }

  attach(page, tabId) {
    if (this.pageIds.has(page)) return;
    this.pageIds.set(page, tabId);
    page.on('request', (request) => this.onRequest(tabId, request));
    page.on('response', (response) => {
      const job = this.onResponse(response).catch(() => {});
      this.responseJobs.set(response.request(), job);
    });
    page.on('requestfinished', (request) => { void this.finish(request).catch(() => {}); });
    page.on('requestfailed', (request) => { void this.finish(request, request.failure()?.errorText || 'failed').catch(() => {}); });
  }

  onRequest(tabId, request) {
    const mappings = [];
    for (const scope of this.scopeStore.scopes.values()) {
      if (scope.currentTabId !== tabId) continue;
      const body = request.postData();
      const record = { n: this.nextNumber++, tabId, method: request.method(), url: request.url(),
        resourceType: request.resourceType(), requestHeaders: request.headers(),
        postData: body?.slice(0, BODY_LIMIT), postDataTruncated: Boolean(body && body.length > BODY_LIMIT),
        startedAt: new Date().toISOString(), startedMs: Date.now(), status: null, ms: null };
      scope.reqCache.push(record);
      if (scope.reqCache.length > this.maxSize) scope.reqCache.splice(0, scope.reqCache.length - this.maxSize);
      mappings.push({ scope, record });
      this.onEvent({ type: 'net.req', scope: scope.key, phase: 'started', ...requestSummary(record) });
    }
    this.requestRecords.set(request, mappings);
  }

  async onResponse(response) {
    const mappings = this.requestRecords.get(response.request()) || [];
    const headers = await response.allHeaders().catch(() => ({}));
    for (const { record } of mappings) {
      Object.assign(record, { status: response.status(), statusText: response.statusText(), responseHeaders: headers,
        ms: Date.now() - record.startedMs });
    }
  }

  async finish(request, failure) {
    await this.responseJobs.get(request);
    const mappings = this.requestRecords.get(request) || [];
    if (!mappings.length) return;
    const response = failure ? null : await request.response();
    let body, bodySize, bodyOmitted;
    const contentType = mappings[0].record.responseHeaders?.['content-type'] || '';
    const length = Number(mappings[0].record.responseHeaders?.['content-length']);
    if (response && /text|json|javascript|xml|form-urlencoded/.test(contentType)) {
      // Only fetch bodies with a known bounded size; streaming/unknown bodies stay metadata-only.
      if (Number.isFinite(length) && length >= 0 && length <= BODY_LIMIT) {
        const bytes = await response.body().catch(() => null);
        if (bytes) { bodySize = bytes.length; body = bytes.subarray(0, BODY_LIMIT).toString('utf8'); }
      } else bodyOmitted = 'body size unknown or exceeds 64 KiB';
    } else if (response) bodyOmitted = 'binary body omitted';
    for (const { scope, record } of mappings) {
      Object.assign(record, { ms: Date.now() - record.startedMs, body, bodySize, bodyOmitted, failure });
      if (this.scopeStore.scopes.get(scope.key) === scope && scope.reqCache.includes(record)) {
        this.onEvent({ type: 'net.req', scope: scope.key, phase: 'finished', ...requestSummary(record) });
      }
    }
  }
}
