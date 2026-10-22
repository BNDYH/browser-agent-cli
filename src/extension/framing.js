export function nativeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 1_000_000) throw new Error('native host command exceeds 1 MB');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class NativeDecoder {
  constructor(onMessage, maxSize = 32 * 1024 * 1024) { this.buffer = Buffer.alloc(0); this.onMessage = onMessage; this.maxSize = maxSize; }
  push(bytes) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE();
      if (size > this.maxSize || size === 0) throw new Error('invalid native message size');
      if (this.buffer.length < size + 4) break;
      const message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'));
      this.buffer = this.buffer.subarray(size + 4);
      this.onMessage(message);
    }
  }
}
