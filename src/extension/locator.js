import { DtError } from '../errors.js';
import { delay, unwrap } from './page.js';

// Executed in an isolated frame world. Text and role selectors deliberately cover
// common CLI forms, not the complete Playwright selector grammar.
export function queryElements(selector) {
  const roots = [document];
  const all = [];
  for (let i = 0; i < roots.length; i++) {
    for (const element of roots[i].querySelectorAll('*')) {
      if (element.closest('[data-dt-overlay]')) continue;
      all.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  if (selector.startsWith('text=')) {
    let text = selector.slice(5), exact = false;
    if (text.startsWith('"') && text.endsWith('"')) { text = JSON.parse(text); exact = true; }
    const normalize = (s) => String(s).replace(/\s+/g, ' ').trim();
    const match = (el) => exact ? normalize(el.textContent) === normalize(text) : normalize(el.textContent).includes(normalize(text));
    return all.filter((el) => !['SCRIPT', 'STYLE', 'HEAD'].includes(el.tagName) && match(el) && ![...el.children].some(match));
  }
  if (selector.startsWith('role=')) throw new Error('role selectors are resolved against the accessibility tree');
  const css = selector.startsWith('css=') ? selector.slice(4) : selector;
  if (selector.includes('>>') || /^(xpath|id|internal:)/.test(selector)) throw new Error('unsupported extension selector; use CSS, text=, role= or a snapshot ref');
  return all.filter((el) => el.matches(css));
}

export class ExtensionLocator {
  constructor(page, selector, frameId) { this.page = page; this.selector = selector; this.frameId = frameId; }

  async withArray(fn) {
    if (this.selector.startsWith('role=')) return this.withRoleArray(fn);
    const object = await this.page.evaluateInFrame(`(${queryElements.toString()})(${JSON.stringify(this.selector)})`, this.frameId);
    try { return await fn(object.objectId); }
    finally { if (object.objectId) await this.page.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
  }
  async withRoleArray(fn) {
    const parsed = /^role=([a-z]+)(?:\[name=("(?:[^"\\]|\\.)*"|[^\]]+)\])?$/.exec(this.selector);
    if (!parsed) throw new DtError('extension role selector supports role=button[name="Name"]; use snapshot refs for other forms', -32602);
    const name = parsed[2]?.startsWith('"') ? JSON.parse(parsed[2]) : parsed[2];
    const { nodes } = await this.page.send('Accessibility.getFullAXTree', this.frameId ? { frameId: this.frameId } : {});
    const matches = nodes.filter((node) => !node.ignored && node.role?.value === parsed[1] &&
      (name === undefined || node.name?.value === name) && node.backendDOMNodeId);
    const objectIds = [];
    try {
      for (const node of matches) {
        const { object } = await this.page.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
        objectIds.push(object.objectId);
      }
      if (!objectIds.length) {
        const empty = await this.page.evaluateInFrame('[]', this.frameId);
        objectIds.push(empty.objectId);
        return await fn(empty.objectId);
      }
      const result = await this.page.send('Runtime.callFunctionOn', { objectId: objectIds[0],
        functionDeclaration: 'function(...nodes) { return nodes; }', arguments: objectIds.map((objectId) => ({ objectId })) });
      objectIds.push(result.result.objectId);
      return await fn(result.result.objectId);
    } finally {
      await Promise.allSettled(objectIds.map((objectId) => this.page.send('Runtime.releaseObject', { objectId })));
    }
  }
  async evaluateAll(fn) {
    return this.withArray(async (objectId) => unwrap(await this.page.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration: `function() { return (${fn.toString()})(this); }`, returnByValue: true, awaitPromise: true,
    })));
  }
  count() { return this.evaluateAll((nodes) => nodes.length); }

  async element(action, arg, { timeout = 10_000, visible = true } = {}) {
    const deadline = Date.now() + timeout;
    while (true) {
      const result = await this.withArray(async (objectId) => unwrap(await this.page.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(arg) {
          if (this.length > 1) throw new Error('selector matched multiple elements; use a unique snapshot ref');
          const el = this[0];
          if (!el || !el.isConnected) return { retry: true };
          const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
          if (${visible} && (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none')) return { retry: true };
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { retry: true };
          return { value: (${action.toString()})(el, arg) };
        }`, arguments: [{ value: arg }], awaitPromise: true, returnByValue: true,
      })));
      if (!result?.retry) return result?.value;
      if (Date.now() >= deadline) throw new DtError(`element timeout: ${this.selector}`);
      await delay(50);
    }
  }
  async waitFor(options) { await this.element(() => true, undefined, options); }

  async point(options) {
    await this.element((el) => { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }, undefined, options);
    // CDP quads are relative to the top-level viewport, including same-process iframe offsets.
    return this.withArray(async (objectId) => {
      const result = await this.page.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { return this[0]; }' });
      const elementId = result.result.objectId;
      try {
        const { quads } = await this.page.send('DOM.getContentQuads', { objectId: elementId });
        if (!quads?.length) throw new DtError('element has no clickable area');
        const q = quads[0];
        const point = { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
        const hit = unwrap(await this.page.send('Runtime.callFunctionOn', { objectId: elementId,
          functionDeclaration: `function() {
            const r = this.getBoundingClientRect();
            const hit = this.getRootNode().elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return hit === this || this.contains(hit);
          }`, returnByValue: true }));
        if (!hit) throw new DtError('element is obscured; inspect the page before retrying');
        return point;
      } finally { await this.page.send('Runtime.releaseObject', { objectId: elementId }).catch(() => {}); }
    });
  }
  async click(options) { await this.mouseClick(1, options); }
  async dblclick(options) { await this.mouseClick(2, options); }
  async mouseClick(times, options) {
    const point = await this.point(options);
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    for (let i = 1; i <= times; i++) {
      await this.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: i, ...point });
      await this.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: i, ...point });
    }
  }
  async fill(text, options) {
    await this.element((el) => {
      if (el.readOnly) throw new Error('element is read-only');
      if (!['INPUT', 'TEXTAREA'].includes(el.tagName) && !el.isContentEditable) throw new Error('element is not editable');
      el.focus();
      if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
      else {
        if (el.tagName === 'INPUT' && !['text', 'search', 'tel', 'url', 'password', 'email'].includes(el.type)) throw new Error('extension fill currently supports text fields and contenteditable; use eval for other input types');
        el.select();
      }
    }, undefined, options);
    if (text) await this.page.send('Input.insertText', { text });
    else {
      await this.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
  }
  async pressSequentially(text, options = {}) {
    await this.element((el) => { if (el.readOnly) throw new Error('element is read-only'); el.focus(); }, undefined, options);
    const deadline = Date.now() + (options.timeout ?? 10_000);
    for (const char of text) {
      if (Date.now() > deadline) throw new DtError('typing timed out; text may be partially entered');
      await this.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char });
      await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
      if (options.delay) await delay(options.delay);
    }
  }
  async selectOption(value, options) {
    return this.element((el, chosen) => {
      if (el.tagName !== 'SELECT') throw new Error('element is not a select');
      if (![...el.options].some((option) => option.value === chosen)) throw new Error('option value not found');
      el.value = chosen;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return [el.value];
    }, value, options);
  }
}
