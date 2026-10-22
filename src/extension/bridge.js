import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DtError } from '../errors.js';
import { EXTENSION_ID, BRIDGE_PROTOCOL } from './constants.js';

export class ExtensionBridge extends EventEmitter {
  constructor() { super(); this.peer = null; this.pending = new Map(); this.browserId = null; }
  get connected() { return Boolean(this.peer && !this.peer.destroyed); }

  accept(socket, hello) {
    if (hello?.protocol !== BRIDGE_PROTOCOL || hello?.extensionId !== EXTENSION_ID ||
        typeof hello?.browserId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(hello.browserId)) {
      socket.end(JSON.stringify({ type: 'error', message: 'invalid extension handshake' }) + '\n');
      return;
    }
    if (this.connected) {
      socket.end(JSON.stringify({ type: 'error', message: 'another Chrome profile is already connected; disconnect it first' }) + '\n');
      return;
    }
    this.peer = socket;
    this.browserId = 'extension:' + hello.browserId;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 48 * 1024 * 1024) return socket.destroy();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'event') this.emit('event', message);
          else if (message.type === 'response') {
            const pending = this.pending.get(message.id);
            if (pending) {
              this.pending.delete(message.id); clearTimeout(pending.timer);
              if (message.error) pending.reject(new DtError(message.error.message, -32000));
              else pending.resolve(message.result);
            }
          }
        } catch { socket.destroy(); return; }
      }
    });
    socket.on('close', () => {
      if (this.peer !== socket) return;
      this.peer = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer); reject(new DtError('extension disconnected; operation was not retried', -32001));
      }
      this.pending.clear(); this.emit('disconnected');
    });
    socket.write(JSON.stringify({ type: 'ready', protocol: BRIDGE_PROTOCOL }) + '\n');
    this.emit('connected');
  }

  call(method, params = {}, timeout = 15_000) {
    if (!this.connected) return Promise.reject(new DtError('extension is not connected; open DT Browser Bridge in Chrome and click Connect', -32001));
    if (this.peer.writableLength > 2_000_000) return Promise.reject(new DtError('extension transport is busy', -32003));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DtError('extension command timed out; it may still be running and was not retried'));
        // A timed-out command must not overlap a newly leased command. Disconnect
        // the transport so the extension detaches rather than accepting more work.
        this.peer?.destroy();
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.peer.write(JSON.stringify({ type: 'command', id, method, params }) + '\n');
    });
  }
  close() { this.peer?.destroy(); }
}
