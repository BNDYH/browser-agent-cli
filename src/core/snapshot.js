import { randomBytes } from 'node:crypto';

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem']);

export function serializeSnapshot({ url, title, elements, nodes = elements, image, warnings = [] }) {
  const lines = [title, url, ...nodes.map((node) =>
    `${'  '.repeat(Math.min(node.level || 0, 20))}[${node.role}] ${node.name || ''}${node.ref ? ' ' + node.ref : ''}`)];
  return { ok: true, url, title, elements, nodes, text: lines.join('\n').slice(0, 100_000),
    ...(image ? { image } : {}), ...(warnings.length ? { warnings } : {}) };
}

export async function takeSnapshot(page, withImage = false) {
  const session = await page.context().newCDPSession(page);
  const group = 'dt-snapshot-' + randomBytes(6).toString('hex');
  const elements = [], nodes = [], warnings = [];
  try {
    // Main document and frames hosted by this target. OOPIFs are reported if inaccessible.
    const { frameTree } = await session.send('Page.getFrameTree');
    const frames = [];
    const visitFrames = (tree) => { frames.push(tree.frame); (tree.childFrames || []).forEach(visitFrames); };
    visitFrames(frameTree);
    for (const frame of frames) {
      let tree;
      try { tree = (await session.send('Accessibility.getFullAXTree', { frameId: frame.id })).nodes; }
      catch { warnings.push(`frame not included: ${frame.url}`); continue; }
      const byId = new Map(tree.map((node) => [node.nodeId, node]));
      const visit = async (node, level) => {
        if (!node || nodes.length >= 2000) return;
        const role = node.role?.value;
        const props = Object.fromEntries((node.properties || []).map((prop) => [prop.name, prop.value?.value]));
        const useful = !node.ignored && !['none', 'generic', 'InlineTextBox'].includes(role);
        let item;
        if (useful) {
          item = { role, name: String(node.name?.value || '').slice(0, 2000), level,
            ...(props.checked === undefined ? {} : { checked: props.checked }),
            ...(props.disabled ? { disabled: true } : {}),
            ...(props.expanded === undefined ? {} : { expanded: props.expanded }),
            ...(frame.id === frameTree.frame.id ? {} : { frameUrl: frame.url }) };
          // Use Chrome-computed roles and accessible names; never replace website IDs.
          if ((INTERACTIVE.has(role) || props.focusable) && node.backendDOMNodeId) {
            try {
              const { object } = await session.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId, objectGroup: group });
              const refValue = group + '-' + elements.length;
              const response = await session.send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration: 'function(ref) { if (this.nodeType !== 1 || this.closest("[data-dt-overlay]")) return null; this.setAttribute("data-dt-ref", ref); return { password: this.type === "password", optionValue: this.tagName === "OPTION" ? this.value : null }; }',
                arguments: [{ value: refValue }], returnByValue: true,
              });
              if (response.result.value) {
                item.ref = `[data-dt-ref="${refValue}"]`;
                item.selector = item.ref;
                if (!response.result.value.password && node.value?.value !== undefined) item.value = String(node.value.value).slice(0, 2000);
                if (response.result.value.optionValue !== null) item.value = response.result.value.optionValue;
                elements.push(item);
              }
            } catch { /* Element detached while observing; omit its action reference. */ }
          }
          nodes.push(item);
        }
        for (const id of node.childIds || []) await visit(byId.get(id), level + (useful ? 1 : 0));
      };
      await visit(tree[0], 0);
    }
    if (nodes.length >= 2000) warnings.push('snapshot truncated at 2000 semantic nodes');
    if (page.frames().length > frames.length) warnings.push('some cross-process frames are not included');
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
    await session.detach().catch(() => {});
  }
  return serializeSnapshot({ url: page.url(), title: await page.title(), elements, nodes, warnings,
    ...(withImage ? { image: (await page.screenshot()).toString('base64') } : {}) });
}
