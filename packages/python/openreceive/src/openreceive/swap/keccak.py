"""Keccak-256 — the pre-NIST-padding variant Ethereum uses, which is NOT
`hashlib.sha3_256` (SHA-3 pads with 0x06, Keccak with 0x01). Needed only to
verify EIP-55 checksums on refund addresses, so this is a compact reference
implementation rather than a dependency. Port of Ruby `OpenReceive::Keccak256`."""

from __future__ import annotations

ROUNDS = 24
RATE_BYTES = 136  # 1088-bit rate for Keccak-256.
MASK = 0xFFFFFFFFFFFFFFFF

ROUND_CONSTANTS = (
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
)  # fmt: skip

ROTATION_OFFSETS = (
    (0, 36, 3, 41, 18),
    (1, 44, 10, 45, 2),
    (62, 6, 43, 15, 61),
    (28, 55, 25, 21, 56),
    (27, 20, 39, 8, 14),
)


def _rotl(value: int, offset: int) -> int:
    offset %= 64
    if offset == 0:
        return value
    return ((value << offset) | (value >> (64 - offset))) & MASK


def _keccak_f(state: list[int]) -> None:
    for round_index in range(ROUNDS):
        # theta
        columns = [
            state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
            for x in range(5)
        ]
        for x in range(5):
            d = columns[(x + 4) % 5] ^ _rotl(columns[(x + 1) % 5], 1)
            for y in range(5):
                state[x + 5 * y] ^= d
        # rho + pi
        rotated = [0] * 25
        for x in range(5):
            for y in range(5):
                rotated[y + 5 * ((2 * x + 3 * y) % 5)] = _rotl(
                    state[x + 5 * y], ROTATION_OFFSETS[x][y]
                )
        # chi
        for y in range(5):
            row = rotated[5 * y : 5 * y + 5]
            for x in range(5):
                state[x + 5 * y] = row[x] ^ ((~row[(x + 1) % 5]) & MASK & row[(x + 2) % 5])
        # iota
        state[0] ^= ROUND_CONSTANTS[round_index]


def _pad(message: bytes) -> bytes:
    padding_length = RATE_BYTES - (len(message) % RATE_BYTES)
    padding = bytearray(padding_length)
    padding[0] = 0x01  # Keccak padding is 0x01 … 0x80 (SHA-3 would use 0x06).
    padding[-1] |= 0x80
    return message + bytes(padding)


def digest(message: bytes) -> bytes:
    state = [0] * 25
    padded = _pad(message)
    for block_start in range(0, len(padded), RATE_BYTES):
        block = padded[block_start : block_start + RATE_BYTES]
        for lane in range(RATE_BYTES // 8):
            state[lane] ^= int.from_bytes(block[lane * 8 : lane * 8 + 8], "little")
        _keccak_f(state)
    # Keccak-256 output is the first 32 bytes of the rate portion.
    return b"".join(state[lane].to_bytes(8, "little") for lane in range(4))
