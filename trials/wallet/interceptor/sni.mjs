// The server name a TLS ClientHello asks for (SNI), read before the handshake
// so the interceptor can pick the rule for that host before it answers.

/**
 * The server name in a TLS ClientHello, or undefined. `buffer` holds the
 * first record; returns null while the record is still incomplete.
 */
export function serverName(buffer) {
  if (buffer.length < 5) return null;
  if (buffer[0] !== 0x16) return undefined;
  const recordLength = buffer.readUInt16BE(3);
  if (buffer.length < 5 + recordLength) return null;
  let at = 5;
  if (buffer[at] !== 0x01) return undefined;
  at += 4; // handshake type + length
  at += 2 + 32; // client version + random
  if (at >= buffer.length) return undefined;
  at += 1 + buffer[at]; // session id
  if (at + 2 > buffer.length) return undefined;
  at += 2 + buffer.readUInt16BE(at); // cipher suites
  if (at >= buffer.length) return undefined;
  at += 1 + buffer[at]; // compression methods
  if (at + 2 > buffer.length) return undefined;
  const end = Math.min(buffer.length, at + 2 + buffer.readUInt16BE(at));
  at += 2;
  while (at + 4 <= end) {
    const type = buffer.readUInt16BE(at);
    const length = buffer.readUInt16BE(at + 2);
    at += 4;
    if (type === 0x0000 && at + 5 <= end) {
      const nameType = buffer[at + 2];
      const nameLength = buffer.readUInt16BE(at + 3);
      if (nameType === 0 && at + 5 + nameLength <= end) {
        return buffer
          .subarray(at + 5, at + 5 + nameLength)
          .toString("ascii")
          .toLowerCase();
      }
      return undefined;
    }
    at += length;
  }
  return undefined;
}
