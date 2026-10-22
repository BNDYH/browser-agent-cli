import test from 'node:test';
import assert from 'node:assert/strict';
import { OVERLAY_ID, overlayScript } from '../../src/core/overlay.js';

test('overlay script has stable id, label and non-blocking container', () => {
  const source = overlayScript('s/t').toString();
  assert.equal(OVERLAY_ID, '__dt_control_overlay__');
  assert.match(source, /pointer-events:none/);
  assert.match(source, /aria-label/);
});
