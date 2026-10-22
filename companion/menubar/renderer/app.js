const $ = (id) => document.getElementById(id);
const dragSurface = $('drag-surface');
let dragPointer;
dragSurface.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || dragPointer !== undefined) return;
  event.preventDefault();
  dragPointer = event.pointerId;
  dragSurface.setPointerCapture(event.pointerId);
  dragSurface.classList.add('dragging');
  window.dt.drag('start', event.screenX, event.screenY);
});
dragSurface.addEventListener('pointermove', (event) => {
  if (event.pointerId === dragPointer) window.dt.drag('move', event.screenX, event.screenY);
});
function endDrag() {
  if (dragPointer === undefined) return;
  const pointer = dragPointer;
  dragPointer = undefined;
  if (dragSurface.hasPointerCapture(pointer)) dragSurface.releasePointerCapture(pointer);
  dragSurface.classList.remove('dragging');
  window.dt.drag('end');
}
dragSurface.addEventListener('pointerup', endDrag);
dragSurface.addEventListener('pointercancel', endDrag);
dragSurface.addEventListener('lostpointercapture', endDrag);
window.addEventListener('blur', endDrag);
let opening = false, canOpen = false;
let noticeTimer;
function showNotice(message) {
  clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4000);
}
let pointerReceived = false;
const renderPointer = (inside) => document.body.classList.toggle('pointer-inside', inside);
window.dt.onPointerInside((inside) => { pointerReceived = true; renderPointer(inside); });
window.dt.pointerInside().then((inside) => { if (!pointerReceived) renderPointer(inside); });
function render(view) {
  $('title').textContent = view.tab?.title || '等待浏览器操作';
  const image = typeof view.image === 'string' && view.image.startsWith('data:image/jpeg;base64,') ? view.image : null;
  $('preview').hidden = !image;
  $('empty').hidden = Boolean(image);
  if (image) $('preview').src = image;
  else $('preview').removeAttribute('src');
  canOpen = Boolean(view.tab?.id) && view.status !== 'unavailable';
  $('open-page').disabled = opening || !canOpen;
  $('status').textContent = view.status === 'ready' ? '操作已完成 · 预览已暂停' : view.status === 'busy'
    ? (image ? '页面操作中 · 显示最近预览' : '页面操作中 · 等待预览')
    : view.status === 'loading' ? '正在更新预览' : '暂无可用预览';
}
$('open-page').onclick = async () => {
  if (opening || !canOpen) return;
  opening = true; $('open-page').disabled = true;
  try {
    const result = await window.dt.openPage();
    $('open-page').title = result.ok ? '打开当前页面' : result.message;
    if (!result.ok) { $('status').textContent = result.message; showNotice(result.message); }
  } catch {
    $('open-page').title = '无法打开页面，请检查浏览器连接';
    showNotice('无法打开页面，请检查浏览器连接');
  } finally { opening = false; $('open-page').disabled = !canOpen; }
};
let received = false;
window.dt.subscribe((view) => { received = true; render(view); });
const initial = await window.dt.preview();
if (!received) render(initial);
