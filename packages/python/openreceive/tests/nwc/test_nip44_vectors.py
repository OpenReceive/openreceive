"""Conformance against the official NIP-44 vectors (paulmillr/nip44, MIT)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from openreceive.nwc.transport import nip44
from openreceive.nwc.transport.nip01 import KeyPair

VECTORS: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "nip44.vectors.json").read_text()
)["v2"]
VALID, INVALID = VECTORS["valid"], VECTORS["invalid"]


def _conversation_key(sec1: str, pub2: str) -> bytes:
    return nip44.conversation_key(KeyPair(sec1).shared_x(pub2))


@pytest.mark.parametrize("vector", VALID["get_conversation_key"])
def test_get_conversation_key(vector: dict[str, str]) -> None:
    assert _conversation_key(vector["sec1"], vector["pub2"]).hex() == vector["conversation_key"]


@pytest.mark.parametrize("vector", VALID["get_message_keys"]["keys"])
def test_get_message_keys(vector: dict[str, str]) -> None:
    conv_key = bytes.fromhex(VALID["get_message_keys"]["conversation_key"])
    chacha_key, chacha_nonce, hmac_key = nip44.message_keys(
        conv_key, bytes.fromhex(vector["nonce"])
    )
    assert chacha_key.hex() == vector["chacha_key"]
    assert chacha_nonce.hex() == vector["chacha_nonce"]
    assert hmac_key.hex() == vector["hmac_key"]


@pytest.mark.parametrize("unpadded,padded", VALID["calc_padded_len"])
def test_calc_padded_len(unpadded: int, padded: int) -> None:
    assert nip44.calc_padded_len(unpadded) == padded


@pytest.mark.parametrize("vector", VALID["encrypt_decrypt"])
def test_encrypt_decrypt(vector: dict[str, str]) -> None:
    conv_key = _conversation_key(vector["sec1"], KeyPair(vector["sec2"]).pubkey)
    assert conv_key.hex() == vector["conversation_key"]
    payload = nip44.encrypt(vector["plaintext"], conv_key, bytes.fromhex(vector["nonce"]))
    assert payload == vector["payload"]
    assert nip44.decrypt(vector["payload"], conv_key) == vector["plaintext"]


@pytest.mark.parametrize("vector", VALID["encrypt_decrypt_long_msg"])
def test_encrypt_decrypt_long_msg(vector: dict[str, Any]) -> None:
    conv_key = bytes.fromhex(vector["conversation_key"])
    plaintext = vector["pattern"] * vector["repeat"]
    assert hashlib.sha256(plaintext.encode()).hexdigest() == vector["plaintext_sha256"]
    payload = nip44.encrypt(plaintext, conv_key, bytes.fromhex(vector["nonce"]))
    assert hashlib.sha256(payload.encode()).hexdigest() == vector["payload_sha256"]
    assert nip44.decrypt(payload, conv_key) == plaintext


@pytest.mark.parametrize("length", INVALID["encrypt_msg_lengths"])
def test_invalid_message_lengths(length: int) -> None:
    with pytest.raises(ValueError):
        nip44.encrypt("a" * length, b"\x01" * 32, b"\x02" * 32)


@pytest.mark.parametrize("vector", INVALID["get_conversation_key"])
def test_invalid_conversation_key(vector: dict[str, str]) -> None:
    with pytest.raises(Exception):  # noqa: B017 — coincurve raises its own ValueError subtypes
        _conversation_key(vector["sec1"], vector["pub2"])


@pytest.mark.parametrize("vector", INVALID["decrypt"])
def test_invalid_decrypt(vector: dict[str, str]) -> None:
    with pytest.raises(ValueError):
        nip44.decrypt(vector["payload"], bytes.fromhex(vector["conversation_key"]))


def test_random_nonce_round_trip() -> None:
    conv_key = _conversation_key("01" * 32, KeyPair("02" * 32).pubkey)
    payload = nip44.encrypt('{"method":"get_info","params":{}}', conv_key)
    assert nip44.decrypt(payload, conv_key) == '{"method":"get_info","params":{}}'
