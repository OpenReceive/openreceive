"""NIP-04 encryption (AES-256-CBC keyed by the ECDH x coordinate, ``<ct>?iv=<iv>``)."""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def encrypt(plaintext: str, shared_x: bytes, iv: bytes | None = None) -> str:
    iv = os.urandom(16) if iv is None else iv
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()
    encryptor = Cipher(algorithms.AES(shared_x), modes.CBC(iv)).encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    return (
        f"{base64.b64encode(ciphertext).decode('ascii')}?iv={base64.b64encode(iv).decode('ascii')}"
    )


def decrypt(payload: str, shared_x: bytes) -> str:
    ciphertext_b64, separator, iv_b64 = payload.partition("?iv=")
    if not separator:
        raise ValueError("missing iv")
    iv = base64.b64decode(iv_b64, validate=True)
    ciphertext = base64.b64decode(ciphertext_b64, validate=True)
    if len(iv) != 16 or len(ciphertext) % 16 != 0 or not ciphertext:
        raise ValueError("invalid ciphertext")
    decryptor = Cipher(algorithms.AES(shared_x), modes.CBC(iv)).decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    return (unpadder.update(padded) + unpadder.finalize()).decode("utf-8")
