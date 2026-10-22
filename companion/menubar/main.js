import { app, ipcMain, nativeImage, Menu, screen } from 'electron';
import { menubar } from 'menubar';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { rpcCall } from '../../src/daemon/rpc.js';
import { getConfig } from '../../src/config.js';
import { EventFeed } from './events.js';
import { emptyState, reduceEvent, disconnected } from './model.js';
import { Preview, currentPage } from './preview.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const index = new URL('./renderer/index.html', import.meta.url).href;
const config = getConfig();
const windowMargin = 16;

function keepWindowOnScreen(window) {
  if (!window || window.isDestroyed()) return;
  const bounds = window.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, Math.max(1, area.width - windowMargin * 2));
  const height = Math.min(bounds.height, Math.max(1, area.height - windowMargin * 2));
  const x = Math.min(Math.max(bounds.x, area.x + windowMargin), area.x + area.width - width - windowMargin);
  const y = Math.min(Math.max(bounds.y, area.y + windowMargin), area.y + area.height - height - windowMargin);
  if (width !== bounds.width || height !== bounds.height) window.setSize(width, height);
  if (x !== bounds.x || y !== bounds.y) window.setPosition(x, y);
}

// Separate state directories have separate panels; concurrent CLI calls share one.
fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(config.stateDir, 'companion-profile'));
if (!app.requestSingleInstanceLock()) app.exit(0);
const pidPath = path.join(config.stateDir, 'companion.pid');
fs.writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
app.on('will-quit', () => {
  try { if (fs.readFileSync(pidPath, 'utf8') === String(process.pid)) fs.unlinkSync(pidPath); } catch {}
});
let state = emptyState();
const feed = new EventFeed(config.socketPath);
const mb = menubar({ index, icon: nativeImage.createEmpty(), preloadWindow: true,
  tooltip: 'DT 页面预览', browserWindow: { width: 420, height: 260, resizable: false, movable: true, alwaysOnTop: true,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: true, roundedCorners: false,
    acceptFirstMouse: true,
    webPreferences: { preload: path.join(directory, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } } });
app.on('second-instance', () => { if (mb.window) mb.showWindow(); });
let view = { status: 'unavailable', image: null };
const preview = new Preview(config.socketPath, () => state, (value) => {
  const thumbnail = value.image ? nativeImage.createFromDataURL(value.image).resize({ width: 640 }) : null;
  view = thumbnail ? { ...value, image: 'data:image/jpeg;base64,' + thumbnail.toJPEG(55).toString('base64') } : value;
  if (thumbnail && !thumbnail.isEmpty() && mb.window && !mb.window.isDestroyed()) {
    const { width, height } = thumbnail.getSize();
    const bounds = mb.window.getBounds();
    const available = screen.getDisplayMatching(bounds).workArea;
    const targetHeight = Math.max(48, Math.min(available.height - 48, Math.round(bounds.width * height / width)));
    if (bounds.height !== targetHeight) {
      mb.window.setSize(bounds.width, targetHeight);
      keepWindowOnScreen(mb.window);
    }
  }
  if (mb.window && !mb.window.isDestroyed()) mb.window.webContents.send('dt:preview', view);
});

function publish() {
  const active = state.scopes.filter((scope) => scope.currentCommand).length;
  mb.tray?.setTitle(active && state.connected ? '🔴 dt' : 'dt');
  mb.tray?.setToolTip(state.connected ? 'DT · 当前页面预览' : 'DT · 等待 daemon');
  void preview.refresh();
}
feed.on('event', (event) => {
  state = reduceEvent(state, event); publish();
  if (event.type === 'cmd.start') mb.showWindow();
});
feed.on('disconnected', () => { state = disconnected(state); publish(); });

function checkSender(event) {
  if (event.sender !== mb.window?.webContents || event.senderFrame?.url !== index) throw new Error('untrusted companion renderer');
}
let dragOrigin;
function endDrag() {
  if (!dragOrigin) return;
  dragOrigin = undefined;
  keepWindowOnScreen(mb.window);
  const { x, y } = mb.window.getBounds();
  // menubar repositions on every showWindow(), including command starts.
  mb.setOption('browserWindow', { ...mb.getOption('browserWindow'), x, y });
}
ipcMain.on('dt:drag', (event, point) => {
  checkSender(event);
  const window = mb.window;
  if (!window || window.isDestroyed() || !window.isVisible()) return;
  if (point?.type === 'end') return endDrag();
  if (!Number.isFinite(point?.screenX) || !Number.isFinite(point?.screenY)) return;
  if (point.type === 'start') {
    dragOrigin = { ...window.getBounds(), screenX: point.screenX, screenY: point.screenY };
  } else if (point.type === 'move' && dragOrigin) {
    const x = Math.round(dragOrigin.x + point.screenX - dragOrigin.screenX);
    const y = Math.round(dragOrigin.y + point.screenY - dragOrigin.screenY);
    if (Math.abs(x) < 100000 && Math.abs(y) < 100000) window.setPosition(x, y);
  }
});
let pointerInside = false, pointerTimer;
function updatePointer(inside) {
  if (pointerInside === inside) return;
  pointerInside = inside;
  if (mb.window && !mb.window.isDestroyed()) mb.window.webContents.send('dt:pointer-inside', inside);
}
function checkPointer() {
  const window = mb.window;
  if (!window || window.isDestroyed() || !window.isVisible()) return updatePointer(false);
  const { x, y } = screen.getCursorScreenPoint();
  const bounds = window.getBounds();
  updatePointer(x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height);
}
function stopPointer() { clearInterval(pointerTimer); pointerTimer = undefined; updatePointer(false); }
ipcMain.handle('dt:preview', (event) => { checkSender(event); return view; });
ipcMain.handle('dt:pointer-inside', (event) => { checkSender(event); checkPointer(); return pointerInside; });
let opening = false;
ipcMain.handle('dt:open-page', async (event) => {
  checkSender(event);
  const scope = currentPage(state);
  if (!scope || scope.currentTab.id !== view.tab?.id) return { ok: false, message: '页面已变化，请等待预览更新' };
  if (opening) return { ok: false, message: '正在打开页面' };
  opening = true;
  try {
    const reply = await rpcCall(config.socketPath, { jsonrpc: '2.0', id: randomUUID(), method: 'use',
      params: { id: scope.currentTab.id, activate: true },
      scope: { sessionId: scope.sessionId, taskId: scope.taskId } });
    if (reply.error) return { ok: false, message: reply.error.code === -32003 ? '页面正在操作，请稍后重试' : '无法打开页面，请检查浏览器连接' };
    return { ok: true };
  } catch {
    return { ok: false, message: '无法打开页面，请检查浏览器连接' };
  } finally { opening = false; }
});
mb.on('before-load', () => {
  mb.on('after-show', () => keepWindowOnScreen(mb.window));
  mb.window.on('show', () => {
    preview.show(); clearInterval(pointerTimer); checkPointer();
    pointerTimer = setInterval(checkPointer, 100);
  });
  mb.window.on('hide', () => { endDrag(); preview.hide(); stopPointer(); });
  mb.window.on('blur', endDrag);
  mb.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mb.window.webContents.on('will-navigate', (event, url) => { if (url !== index) event.preventDefault(); });
  mb.window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
});
mb.on('ready', () => {
  mb.showWindow();
  mb.tray.on('right-click', () => mb.tray.popUpContextMenu(Menu.buildFromTemplate([
    { label: '查看当前页面', click: () => mb.showWindow() }, { type: 'separator' },
    { label: '退出 DT 面板', click: () => app.quit() },
  ])));
  publish(); feed.start();
});
mb.on('after-close', () => { preview.hide(); stopPointer(); });
app.on('before-quit', () => { preview.hide(); stopPointer(); feed.stop(); });
