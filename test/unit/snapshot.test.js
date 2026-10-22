import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeSnapshot } from '../../src/core/snapshot.js';

test('serializes structured elements and readable text', () => {
  const result = serializeSnapshot({
    url: 'https://example.test', title: 'Example',
    elements: [{ role: 'button', name: 'Submit', selector: '#submit', level: 0 }],
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /\[button\] Submit/);
  assert.equal(result.elements[0].selector, '#submit');
});
