/**
 * Minimal SHA-256 and Keccak-256 used by the swap address checksum guards.
 *
 * Deliberately dependency-free and runtime-neutral: `@openreceive/core` runs in
 * browsers, workers, and Node, so it cannot reach for `node:crypto`, and the
 * Web Crypto digest API is async while address validation is a synchronous
 * predicate on the refund/deposit path. Inputs here are 20–32 byte addresses,
 * so a compact implementation is the right trade.
 */

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

export function sha256(message: Uint8Array): Uint8Array {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLength = message.length * 8;
  // Smallest multiple of 64 with room for the message, the 0x80 marker, and
  // the 8-byte length. (`((len+9)/64|0)*64+64` over-allocated a spurious
  // all-zero block whenever len % 64 == 55, corrupting the digest.)
  const padded = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = state[0] as number;
    let b = state[1] as number;
    let c = state[2] as number;
    let d = state[3] as number;
    let e = state[4] as number;
    let f = state[5] as number;
    let g = state[6] as number;
    let h = state[7] as number;

    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + (SHA256_K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    state[0] = ((state[0] as number) + a) >>> 0;
    state[1] = ((state[1] as number) + b) >>> 0;
    state[2] = ((state[2] as number) + c) >>> 0;
    state[3] = ((state[3] as number) + d) >>> 0;
    state[4] = ((state[4] as number) + e) >>> 0;
    state[5] = ((state[5] as number) + f) >>> 0;
    state[6] = ((state[6] as number) + g) >>> 0;
    state[7] = ((state[7] as number) + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i += 1) digestView.setUint32(i * 4, state[i] as number, false);
  return digest;
}

const KECCAK_MASK = (1n << 64n) - 1n;
const KECCAK_ROTATIONS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
] as const;
const KECCAK_ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
] as const;
/** Keccak-256 bitrate in bytes (1600-bit state minus a 512-bit capacity). */
const KECCAK_RATE_BYTES = 136;

function rotateLeft64(value: bigint, bits: number): bigint {
  if (bits === 0) return value;
  return ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & KECCAK_MASK;
}

function keccakPermute(lanes: bigint[]): void {
  for (const roundConstant of KECCAK_ROUND_CONSTANTS) {
    const columns: bigint[] = [];
    for (let x = 0; x < 5; x += 1) {
      columns[x] =
        (lanes[x] as bigint) ^
        (lanes[x + 5] as bigint) ^
        (lanes[x + 10] as bigint) ^
        (lanes[x + 15] as bigint) ^
        (lanes[x + 20] as bigint);
    }
    const theta: bigint[] = [];
    for (let x = 0; x < 5; x += 1) {
      theta[x] = (columns[(x + 4) % 5] as bigint) ^ rotateLeft64(columns[(x + 1) % 5] as bigint, 1);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        lanes[x + 5 * y] = (lanes[x + 5 * y] as bigint) ^ (theta[x] as bigint);
      }
    }

    const rotated: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        rotated[y + 5 * ((2 * x + 3 * y) % 5)] = rotateLeft64(
          lanes[x + 5 * y] as bigint,
          KECCAK_ROTATIONS[x + 5 * y] as number,
        );
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        lanes[x + 5 * y] =
          (rotated[x + 5 * y] as bigint) ^
          (~(rotated[((x + 1) % 5) + 5 * y] as bigint) &
            KECCAK_MASK &
            (rotated[((x + 2) % 5) + 5 * y] as bigint));
      }
    }

    lanes[0] = (lanes[0] as bigint) ^ roundConstant;
  }
}

/** Original Keccak-256 (0x01 padding), the hash Ethereum's EIP-55 checksum uses. */
export function keccak256(message: Uint8Array): Uint8Array {
  const lanes: bigint[] = new Array(25).fill(0n);
  const padded = new Uint8Array(
    message.length + KECCAK_RATE_BYTES - (message.length % KECCAK_RATE_BYTES),
  );
  padded.set(message);
  padded[message.length] = ((padded[message.length] as number) | 0x01) & 0xff;
  padded[padded.length - 1] = ((padded[padded.length - 1] as number) | 0x80) & 0xff;

  for (let offset = 0; offset < padded.length; offset += KECCAK_RATE_BYTES) {
    for (let lane = 0; lane < KECCAK_RATE_BYTES / 8; lane += 1) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte -= 1) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte] as number);
      }
      lanes[lane] = (lanes[lane] as bigint) ^ value;
    }
    keccakPermute(lanes);
  }

  const digest = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane += 1) {
    let value = lanes[lane] as bigint;
    for (let byte = 0; byte < 8; byte += 1) {
      digest[lane * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return digest;
}
