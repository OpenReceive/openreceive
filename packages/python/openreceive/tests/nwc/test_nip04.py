from __future__ import annotations

import pytest

from openreceive.nwc.transport import nip04
from openreceive.nwc.transport.nip01 import KeyPair


def test_round_trip_and_payload_shape() -> None:
    shared = KeyPair("01" * 32).shared_x(KeyPair("02" * 32).pubkey)
    payload = nip04.encrypt('{"method":"make_invoice"}', shared)
    ciphertext, separator, iv = payload.partition("?iv=")
    assert separator and len(iv) == 24 and ciphertext
    assert nip04.decrypt(payload, shared) == '{"method":"make_invoice"}'


def test_fixed_iv_is_deterministic() -> None:
    shared = KeyPair("01" * 32).shared_x(KeyPair("02" * 32).pubkey)
    first = nip04.encrypt("héllo", shared, b"\x07" * 16)
    assert first == nip04.encrypt("héllo", shared, b"\x07" * 16)
    assert nip04.decrypt(first, shared) == "héllo"


@pytest.mark.parametrize(
    "payload", ["no-iv-here", "AAAA?iv=AAAA", "AAAAAAAAAAAAAAAAAAAAAA==?iv=" + "A" * 24]
)
def test_malformed_payloads_raise(payload: str) -> None:
    shared = KeyPair("01" * 32).shared_x(KeyPair("02" * 32).pubkey)
    with pytest.raises(ValueError):
        nip04.decrypt(payload, shared)
