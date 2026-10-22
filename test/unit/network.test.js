import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRequests, redactHeaders, toHar } from '../../src/core/network.js';

const requests = [
  { n: 1, method: 'GET', url: 'https://example.test/a', startedAt: '2026-01-01T00:00:00.000Z', requestHeaders: { cookie: 'secret' } },
  { n: 2, method: 'POST', url: 'https://example.test/api/order', startedAt: '2026-01-01T00:00:01.000Z', requestHeaders: { authorization: 'Bearer secret', accept: '*/*' } },
];

test('filters by URL substring and HTTP method', () => {
  assert.deepEqual(filterRequests(requests, 'order').map((item) => item.n), [2]);
  assert.deepEqual(filterRequests(requests, 'method:post').map((item) => item.n), [2]);
});

test('redacts sensitive headers in details and HAR', () => {
  assert.equal(redactHeaders(requests[1].requestHeaders).authorization, '<redacted>');
  const har = toHar(requests);
  assert.equal(har.log.entries[0].request.headers[0].value, '<redacted>');
});
