"""NIP-44 v2 encryption (ChaCha20 + HMAC-SHA256, HKDF-derived keys, padded plaintext).

Every function raises ``ValueError`` on malformed input; the transport maps
that to ``TransportError(kind="decrypt")``.
"""

from __future__ import annotations

import base64
import hmac
import math
import os
from hashlib import sha256

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms
from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand

VERSION = 2
_SALT = b"nip44-v2"
_MIN_PLAINTEXT = 1
_MAX_PLAINTEXT = 65535


def conversation_key(shared_x: bytes) -> bytes:
    """HKDF-extract (HMAC-SHA256 keyed by the salt) over the ECDH x coordinate."""
    return hmac.new(_SALT, shared_x, sha256).digest()


def message_keys(conv_key: bytes, nonce: bytes) -> tuple[bytes, bytes, bytes]:
    """HKDF-expand into (chacha_key, chacha_nonce, hmac_key)."""
    keys = HKDFExpand(algorithm=hashes.SHA256(), length=76, info=nonce).derive(conv_key)
    return keys[:32], keys[32:44], keys[44:76]


def calc_padded_len(unpadded_len: int) -> int:
    if unpadded_len <= 32:
        return 32
    next_power = 1 << (math.floor(math.log2(unpadded_len - 1)) + 1)
    chunk = 32 if next_power <= 256 else next_power // 8
    return chunk * ((unpadded_len - 1) // chunk + 1)


def pad(plaintext: str) -> bytes:
    unpadded = plaintext.encode("utf-8")
    length = len(unpadded)
    if length < _MIN_PLAINTEXT or length > _MAX_PLAINTEXT:
        raise ValueError("invalid plaintext length")
    return length.to_bytes(2, "big") + unpadded.ljust(calc_padded_len(length), b"\x00")


def unpad(padded: bytes) -> str:
    length = int.from_bytes(padded[:2], "big")
    unpadded = padded[2 : 2 + length]
    if (
        length < _MIN_PLAINTEXT
        or length > _MAX_PLAINTEXT
        or len(unpadded) != length
        or len(padded) != 2 + calc_padded_len(length)
    ):
        raise ValueError("invalid padding")
    return unpadded.decode("utf-8")


def _chacha20(key: bytes, nonce12: bytes, data: bytes) -> bytes:
    # cryptography wants a 16-byte nonce: 4-byte little-endian counter + the 12-byte nonce.
    encryptor = Cipher(algorithms.ChaCha20(key, b"\x00" * 4 + nonce12), mode=None).encryptor()
    return encryptor.update(data) + encryptor.finalize()


def encrypt(plaintext: str, conv_key: bytes, nonce: bytes | None = None) -> str:
    nonce = os.urandom(32) if nonce is None else nonce
    chacha_key, chacha_nonce, hmac_key = message_keys(conv_key, nonce)
    ciphertext = _chacha20(chacha_key, chacha_nonce, pad(plaintext))
    mac = hmac.new(hmac_key, nonce + ciphertext, sha256).digest()
    return base64.b64encode(bytes([VERSION]) + nonce + ciphertext + mac).decode("ascii")


def decrypt(payload: str, conv_key: bytes) -> str:
    if payload.startswith("#"):
        raise ValueError("unknown encryption version")
    if not 132 <= len(payload) <= 87472:
        raise ValueError("invalid payload length")
    data = base64.b64decode(payload, validate=True)
    if not 99 <= len(data) <= 65603:
        raise ValueError("invalid payload length")
    if data[0] != VERSION:
        raise ValueError("unknown encryption version")
    nonce, ciphertext, mac = data[1:33], data[33:-32], data[-32:]
    chacha_key, chacha_nonce, hmac_key = message_keys(conv_key, nonce)
    expected = hmac.new(hmac_key, nonce + ciphertext, sha256).digest()
    if not hmac.compare_digest(expected, mac):
        raise ValueError("invalid MAC")
    return unpad(_chacha20(chacha_key, chacha_nonce, ciphertext))
