export const OVERLAY_ID = '__dt_control_overlay__';

export function overlayScript(scope = '') {
  return ({ id, label }) => {
    document.getElementById(id)?.remove();
    const root = document.createElement('div');
    root.id = id;
    root.setAttribute('data-dt-overlay', '');
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;padding:7px 10px;background:#b42318;color:#fff;border-radius:6px;font:12px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none;letter-spacing:0';
    const shadow = root.attachShadow({ mode: 'closed' });
    const text = document.createElement('span');
    text.textContent = `DT 控制中${label ? ` · ${label}` : ''}`;
    shadow.append(text);
    const close = document.createElement('button');
    close.type = 'button';
    close.title = '关闭 DT 控制标识';
    close.setAttribute('aria-label', '关闭 DT 控制标识');
    close.textContent = '×';
    close.style.cssText = 'pointer-events:auto;margin-left:8px;padding:0;border:0;background:transparent;color:inherit;font:16px/1 sans-serif;cursor:pointer';
    close.onclick = () => root.remove();
    shadow.append(close);
    (document.documentElement || document.body).append(root);
  };
}

export async function setOverlay(page, enabled, scope = '') {
  if (enabled) await page.evaluate(overlayScript(scope), { id: OVERLAY_ID, label: scope });
  else await page.evaluate((id) => document.getElementById(id)?.remove(), OVERLAY_ID);
}
