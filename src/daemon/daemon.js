import fs from 'node:fs';
import { getConfig, ensureStateDir } from '../config.js';
import { BrowserAgentApi } from '../api.js';
import { createRpcServer, encode } from './rpc.js';

const config = getConfig();
ensureStateDir(config);
const subscribers = new Set();
function broadcast(event) {
  for (const socket of subscribers) {
    if (socket.destroyed || socket.writableLength > 1_000_000) { socket.destroy(); subscribers.delete(socket); }
    else socket.write(encode(event) + '\n');
  }
}
const api = new BrowserAgentApi(config, broadcast);
let initialized = false, shuttingDown = false, idleTimer, startup;
const connections = new Set();
const server = createRpcServer(config.socketPath, async (...args) => {
  await startup;
  return api.dispatch(...args);
}, {
  ready: () => initialized,
  extension: (socket, params) => api.extensionBridge.accept(socket, params),
  async subscribe(socket) {
    await startup;
    if (socket.destroyed || shuttingDown) { socket.destroy(); return; }
    subscribers.add(socket);
    socket.on('close', () => subscribers.delete(socket));
    socket.write(encode(api.eventSnapshot()) + '\n');
  },
});
server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});
let ownsSocket = false;
let socketInode;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  api.stopping = true;
  clearInterval(idleTimer);
  server.close();
  api.persist();
  api.tabs.reset();
  await api.connection.disconnect({ remember: false });
  api.extensionBridge.close();
  for (const socket of connections) socket.destroy();
  if (ownsSocket) {
    try { if (fs.statSync(config.socketPath).ino === socketInode) fs.unlinkSync(config.socketPath); } catch {}
  }
}
server.on('shutdown', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
server.on('error', (error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
server.listen(config.socketPath, () => {
  ownsSocket = true;
  socketInode = fs.statSync(config.socketPath).ino;
  fs.chmodSync(config.socketPath, 0o600);
  startup = api.initialize().then(() => { initialized = true; });
  startup.catch((error) => { process.stderr.write(error.message + '\n'); void shutdown(); });
  idleTimer = setInterval(() => {
    const idleMs = Date.now() - api.lastActiveAt;
    api.emit({ type: 'daemon.heartbeat', idleMs, idleTimeoutMs: config.idleTimeoutMs,
      activeCount: api.busyScopes.size, activeScopes: [...api.scopes.scopes.keys()] });
    if (initialized && !api.activeCount && idleMs > config.idleTimeoutMs) void shutdown();
  }, Math.min(30_000, Math.max(100, config.idleTimeoutMs / 2)));
  idleTimer.unref();
});
