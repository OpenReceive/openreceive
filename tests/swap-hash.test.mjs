import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { keccak256, sha256 } from "../packages/js/core/src/swap/hash.ts";

function toHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

test("sha256 matches node:crypto for every message length 0..200", () => {
  // Sweeps every padding branch, including the len % 64 == 55 boundary (55,
  // 119, 183) where the old allocation appended a spurious all-zero block.
  for (let length = 0; length <= 200; length += 1) {
    const message = Uint8Array.from({ length }, (_, index) => (index * 31 + length) & 0xff);
    const expected = createHash("sha256").update(message).digest("hex");
    assert.equal(toHex(sha256(message)), expected, `sha256 mismatch at length ${length}`);
  }
});

test("keccak256 matches the known empty-message digest", () => {
  // Keccak-256 (0x01 padding), not SHA3-256: the digest EIP-55 checksums use.
  assert.equal(
    toHex(keccak256(new Uint8Array(0))),
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
});
