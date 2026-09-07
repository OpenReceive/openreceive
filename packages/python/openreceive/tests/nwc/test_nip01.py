from __future__ import annotations

from openreceive.nwc.transport.nip01 import (
    KeyPair,
    event_id,
    sign_event,
    tag_value,
    verify_event,
)

# secret 1 -> the generator point; its x coordinate is the best-known secp256k1 vector.
GENERATOR_X = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"


def test_pubkey_from_fixed_secret_is_x_only() -> None:
    keys = KeyPair("00" * 31 + "01")
    assert keys.pubkey == GENERATOR_X
    assert len(keys.pubkey) == 64


def test_event_id_is_sha256_of_nip01_serialization() -> None:
    # [0,"79be…",1700000000,1,[["t","x"]],"héllo"] serialized with no spaces and raw UTF-8.
    ident = event_id(GENERATOR_X, 1700000000, 1, [["t", "x"]], "héllo")
    # Pinned so a serialization change (spaces, escaping) is caught; equals
    # sha256 of the literal string above.
    assert ident == "6b06ffe10b0ea5720c16252f34dc6197cfa124fa595438202dcf9565cf0c14be"


def test_sign_then_verify_and_reject_tampering() -> None:
    keys = KeyPair("ab" * 32)
    event = sign_event(keys, 23194, [["p", "cd" * 32]], "payload", created_at=1700000000)
    assert event["pubkey"] == keys.pubkey
    assert verify_event(event)
    tampered = dict(event, content="payload!")
    assert not verify_event(tampered)
    forged = dict(event, pubkey=KeyPair("ef" * 32).pubkey)
    assert not verify_event(forged)
    assert not verify_event({"id": "zz"})


def test_shared_x_is_symmetric() -> None:
    a, b = KeyPair("01" * 32), KeyPair("02" * 32)
    assert a.shared_x(b.pubkey) == b.shared_x(a.pubkey)
    assert len(a.shared_x(b.pubkey)) == 32


def test_tag_value_reads_first_match() -> None:
    event = {"tags": [["e", "one"], ["e", "two"], ["p"]]}
    assert tag_value(event, "e") == "one"
    assert tag_value(event, "p") is None
    assert tag_value(event, "x") is None
