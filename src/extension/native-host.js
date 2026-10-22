import net from 'node:net';
import { ensureDaemon } from '../cli/commands.js';
import { getConfig } from '../config.js';
import { NativeDecoder, nativeFrame } from './framing.js';
import { EXTENSION_ORIGIN, EXTENSION_ID } from './constants.js';

// Chrome passes the calling extension's origin as argv[2]. stdout is protocol only.
if (process.argv[2] !== EXTENSION_ORIGIN) {
  process.stderr.write('DT native host: unauthorized extension origin\n');
  process.exit(1);
}
let socket, helloReceived = false, ready = false, outgoing = [];
function fail(error) {
  process.stderr.write('DT native host: ' + error.message + '\n');
  try { process.stdout.write(nativeFrame({ type: 'error', message: error.message })); } catch {}
  socket?.destroy(); process.stdin.destroy(); process.exitCode = 1;
}
function send(message) {
  if (process.stdout.writableLength > 4_000_000) throw new Error('native messaging consumer too slow');
  process.stdout.write(nativeFrame(message));
}
const decoder = new NativeDecoder((message) => {
  if (!helloReceived) {
    if (message.type !== 'hello' || message.extensionId !== EXTENSION_ID) throw new Error('expected extension hello');
    helloReceived = true;
    void (async () => {
      const config = getConfig();
      await ensureDaemon(config);
      socket = net.createConnection(config.socketPath);
      socket.setEncoding('utf8');
      socket.on('error', fail);
      socket.on('close', () => { process.stdin.destroy(); process.exitCode = 0; });
      let buffer = '';
      socket.on('data', (chunk) => {
        try {
          buffer += chunk;
          if (buffer.length > 1_000_000) throw new Error('native command exceeds limit');
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const parsed = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            if (parsed.type === 'ready') {
              ready = true;
              for (const queued of outgoing) socket.write(JSON.stringify(queued) + '\n');
              outgoing = [];
            }
            send(parsed);
          }
        } catch (error) { fail(error); }
      });
      socket.on('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: '_extension', params: message }) + '\n'));
    })().catch(fail);
  } else if (ready) {
    if (socket.writableLength > 48 * 1024 * 1024) throw new Error('daemon transport backpressure exceeded');
    socket.write(JSON.stringify(message) + '\n');
  } else {
    if (outgoing.length > 100) throw new Error('extension sent too many messages before handshake');
    outgoing.push(message);
  }
});
process.stdin.on('data', (bytes) => { try { decoder.push(bytes); } catch (error) { fail(error); } });
process.stdin.on('end', () => socket?.destroy());
process.stdout.on('error', () => { socket?.destroy(); process.stdin.destroy(); });
