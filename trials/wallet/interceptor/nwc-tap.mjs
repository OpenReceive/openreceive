// What a shop asks its wallet, read off the connection the interceptor already
// terminates: the WebSocket frames from the shop to the relay. NIP-47 requests
// are encrypted, so this records only that each happened (kind 23194 EVENT
// messages, with their ciphertext). The harness, which holds the trial code,
// tells a scan from an invoice (harness/devtools.ts).

const NWC_REQUEST_KIND = 23194;
const MAX_HEAD_BYTES = 64 * 1024;

/** The bytes a shop sends, handed on with `permessage-deflate` taken out of the upgrade so frames stay readable. */
export class RelayTap {
  #onRequest;
  #head = Buffer.alloc(0);
  #websocket = false;
  #plain = false;
  #frames = Buffer.alloc(0);
  #partial = [];

  /** @param {(event: object) => void} onRequest */
  constructor(onRequest) {
    this.#onRequest = onRequest;
  }

  /** Bytes from the shop; returns the bytes to forward to the relay. */
  fromClient(chunk) {
    if (this.#plain) return chunk;
    if (this.#websocket) {
      this.#frames = Buffer.concat([this.#frames, chunk]);
      this.#parseFrames();
      return chunk;
    }
    this.#head = Buffer.concat([this.#head, chunk]);
    const end = this.#head.indexOf("\r\n\r\n");
    if (end === -1) {
      if (this.#head.length > MAX_HEAD_BYTES) {
        this.#plain = true;
        return this.#head;
      }
      return Buffer.alloc(0);
    }
    const head = this.#head.subarray(0, end + 4).toString("latin1");
    const rest = this.#head.subarray(end + 4);
    this.#head = Buffer.alloc(0);
    if (!/^upgrade:\s*websocket\s*$/im.test(head)) {
      this.#plain = true;
      return Buffer.concat([Buffer.from(head, "latin1"), rest]);
    }
    this.#websocket = true;
    if (rest.length > 0) {
      this.#frames = rest;
      this.#parseFrames();
    }
    return Buffer.concat([
      Buffer.from(head.replace(/^sec-websocket-extensions:.*\r\n/gim, ""), "latin1"),
      rest,
    ]);
  }

  #parseFrames() {
    for (;;) {
      const frame = this.#readFrame();
      if (frame === undefined) return;
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        this.#partial.push(frame.payload);
        if (frame.fin) {
          this.#message(Buffer.concat(this.#partial).toString("utf8"));
          this.#partial = [];
        }
      }
    }
  }

  #readFrame() {
    const buffer = this.#frames;
    if (buffer.length < 2) return undefined;
    const fin = (buffer[0] & 0x80) !== 0;
    const rsv1 = (buffer[0] & 0x40) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let at = 2;
    if (length === 126) {
      if (buffer.length < 4) return undefined;
      length = buffer.readUInt16BE(2);
      at = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return undefined;
      length = Number(buffer.readBigUInt64BE(2));
      at = 10;
    }
    const maskEnd = at + (masked ? 4 : 0);
    if (buffer.length < maskEnd + length) return undefined;
    const payload = Buffer.from(buffer.subarray(maskEnd, maskEnd + length));
    if (masked) {
      const key = buffer.subarray(at, maskEnd);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= key[index % 4];
      }
    }
    this.#frames = buffer.subarray(maskEnd + length);
    return { fin, opcode: rsv1 ? 0xff : opcode, payload };
  }

  #message(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed[0] !== "EVENT") return;
    const event = parsed[1];
    if (typeof event !== "object" || event === null) return;
    if (event.kind === NWC_REQUEST_KIND) {
      this.#onRequest({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        tags: event.tags,
        content: event.content,
      });
    }
  }
}
