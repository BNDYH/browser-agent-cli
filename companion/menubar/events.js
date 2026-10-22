import net from 'node:net';
import { EventEmitter } from 'node:events';

// An observer only: never spawn a daemon or send status commands to keep it alive.
export class EventFeed extends EventEmitter {
  constructor(socketPath, { minDelay = 250, maxDelay = 10_000 } = {}) {
    super(); Object.assign(this, { socketPath, minDelay, maxDelay, retryDelay: minDelay, stopped: true });
  }
  start() { if (this.stopped) { this.stopped = false; this.connect(); } }
  connect() {
    if (this.stopped) return;
    const socket = this.socket = net.createConnection(this.socketPath);
    socket.setEncoding('utf8');
    socket.setTimeout(45_000, () => socket.destroy());
    let buffer = '';
    socket.on('connect', () => socket.write('{"jsonrpc":"2.0","id":1,"method":"_subscribe"}\n'));
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8_000_000) { socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (!event.type || !Number.isInteger(event.revision)) throw new Error('unsupported event protocol');
          if (event.type === 'daemon.status') this.retryDelay = this.minDelay;
          this.emit('event', event);
        } catch { socket.destroy(); return; }
      }
    });
    socket.on('close', () => {
      this.emit('disconnected');
      if (!this.stopped) {
        this.timer = setTimeout(() => this.connect(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, this.maxDelay);
      }
    });
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.socket?.destroy(); }
}
