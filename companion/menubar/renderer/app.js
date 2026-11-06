const $ = id => document.getElementById(id);
const cards = new Map();
let order = [], drag, noticeTimer, layout = {};
function arrange(animate = false) {
  const positions = new Map(order.map(key => [key, cards.get(key).element.getBoundingClientRect()]));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  order.forEach((key, index) => {
    const card = cards.get(key), element = card.element;
    // Read the current visual position before cancelling, so rapid clicks can
    // redirect a running animation without jumping back to its destination.
    const offset = `${index * (layout.step || 0)}px`;
    if (!animate && card.animation?.playState === 'running' && element.style.left === offset && element.style.top === offset) return;
    card.animation?.cancel();
    Object.assign(element.style, { zIndex: index + 1,
      left: offset, top: offset });
    if (!animate || reducedMotion) return;
    const before = positions.get(key), after = element.getBoundingClientRect();
    const x = before.left - after.left, y = before.top - after.top;
    if (!x && !y) return;
    card.animation = element.animate([
      { transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' },
    ], { duration: 260, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  });
}
function raise(id) {
  if (order.at(-1) === id) return;
  order = order.filter(key => key !== id).concat(id);
  arrange(true);
}
function endDrag() {
  if (!drag) return;
  const { surface, pointer } = drag; drag = null;
  if (surface.hasPointerCapture(pointer)) surface.releasePointerCapture(pointer);
  surface.classList.remove('dragging'); window.dt.drag('end');
}
window.addEventListener('blur', endDrag);
function createCard(id) {
  const element = $('card-template').content.firstElementChild.cloneNode(true);
  const find = selector => element.querySelector(selector);
  const surface = find('.drag-surface'), button = find('button');
  const card = { element, find, opening: false };
  element.dataset.pageId = id;
  element.addEventListener('pointerdown', () => raise(id));
  element.addEventListener('keydown', event => {
    if (event.target === element && ['Enter', ' '].includes(event.key)) { event.preventDefault(); raise(id); }
  });
  surface.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault(); element.focus({ preventScroll: true });
    drag = { surface, pointer: event.pointerId };
    surface.setPointerCapture(event.pointerId); surface.classList.add('dragging');
    window.dt.drag('start', event.screenX, event.screenY);
  });
  surface.addEventListener('pointermove', event => {
    if (drag?.pointer === event.pointerId) window.dt.drag('move', event.screenX, event.screenY);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) surface.addEventListener(type, endDrag);
  button.onclick = async () => {
    if (card.opening || button.disabled) return;
    card.opening = true; button.disabled = true;
    try {
      const result = await window.dt.openPage(id);
      if (!result.ok) showNotice(result.message);
    } catch { showNotice('无法打开页面，请检查浏览器连接'); }
    finally { card.opening = false; button.disabled = !card.canOpen; }
  };
  $('cards').append(element); cards.set(id, card); order.push(id);
  return card;
}
function showNotice(message) {
  clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4000);
}
let pointerReceived = false;
const renderPointer = inside => document.body.classList.toggle('pointer-inside', inside);
window.dt.onPointerInside(inside => { pointerReceived = true; renderPointer(inside); });
window.dt.pointerInside().then(inside => { if (!pointerReceived) renderPointer(inside); });
function render(view) {
  layout = view;
  const pages = view.pages.length ? view.pages : [{ id: 'empty', status: 'unavailable' }];
  for (const [id, card] of cards) {
    if (pages.some(page => page.id === id)) continue;
    if (drag?.surface === card.find('.drag-surface')) endDrag();
    card.element.remove(); cards.delete(id); order = order.filter(key => key !== id);
  }
  pages.forEach(page => {
    const card = cards.get(page.id) || createCard(page.id), find = card.find;
    Object.assign(card.element.style, { width: `${view.cardWidth || 420}px`, height: `${view.cardHeight || 260}px` });
    find('#title').textContent = page.tab?.title || '等待浏览器操作';
    card.element.setAttribute('aria-label', page.tab?.title || '等待浏览器操作');
    const image = typeof page.image === 'string' && page.image.startsWith('data:image/jpeg;base64,') ? page.image : null;
    find('img').hidden = !image; find('#empty').hidden = Boolean(image);
    if (image) { if (find('img').getAttribute('src') !== image) find('img').src = image; }
    else find('img').removeAttribute('src');
    card.canOpen = Boolean(page.tab?.id) && page.status !== 'unavailable';
    find('button').disabled = card.opening || !card.canOpen;
    find('footer').textContent = page.status === 'ready' ? '操作已完成 · 预览已暂停' : page.status === 'busy'
      ? (image ? '页面操作中 · 显示最近预览' : '页面操作中 · 等待预览')
      : page.status === 'loading' ? '正在更新预览' : '暂无可用预览';
  });
  arrange();
}
let received = false;
window.dt.subscribe(view => { received = true; render(view); });
const initial = await window.dt.preview();
if (!received) render(initial);
