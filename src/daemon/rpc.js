import net from 'node:net';
import { asRpcError, DtError } from '../errors.js';

export function encode(value) {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item);
}

export function createRpcServer(socketPath, handler, { ready = () => true, subscribe, extension } = {}) {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let buffer = '', handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2_000_000) { socket.destroy(); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      socket.setTimeout(0);
      void (async () => {
        let request;
        try {
          try { request = JSON.parse(buffer.slice(0, newline)); }
          catch { throw new DtError('invalid JSON', -32700); }
          if (!request || request.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof request.id) ||
              typeof request.method !== 'string') throw new DtError('invalid RPC request', -32600);
          if (request.method === '_ping') {
            socket.end(encode({ jsonrpc: '2.0', id: request.id, result: { ok: true, ready: ready() } }) + '\n');
            return;
          }
          if (request.method === '_subscribe' && subscribe) {
            await subscribe(socket);
            return;
          }
          if (request.method === '_extension' && extension) {
            extension(socket, request.params);
            return;
          }
          const result = await handler(request.method, request.params || {}, request.scope);
          const shutdown = Boolean(result?._shutdownDaemon);
          if (shutdown) delete result._shutdownDaemon;
          socket.end(encode({ jsonrpc: '2.0', id: request.id, result }) + '\n', () => {
            if (shutdown) server.emit('shutdown');
          });
        } catch (error) {
          if (!socket.destroyed) socket.end(encode({ jsonrpc: '2.0', id: request?.id ?? null, error: asRpcError(error) }) + '\n');
        }
      })();
    });
  });
  return server;
}

export function rpcCall(socketPath, request, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(
      'daemon request timed out; command may still be running and has not been retried')), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(encode(request) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 64_000_000) return finish(new Error('RPC response exceeds 64 MB'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== request.id) throw new Error('RPC response ID mismatch');
        finish(null, response);
      } catch (error) { finish(error); }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => { if (!settled) finish(new Error('daemon disconnected before responding')); });
  });
}
