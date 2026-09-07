"""NIP-01 keys and events: secp256k1 keypairs, event ids, BIP-340 signatures."""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any

from coincurve import PrivateKey, PublicKey, PublicKeyXOnly

Tags = list[list[str]]


class KeyPair:
    """A secp256k1 keypair from a 32-byte hex secret; ``pubkey`` is x-only hex."""

    def __init__(self, secret_hex: str) -> None:
        secret = bytes.fromhex(secret_hex)
        if len(secret) != 32:
            raise ValueError("secret must be 32 bytes of hex")
        self._private = PrivateKey(secret)
        self.secret: bytes = secret
        self.pubkey: str = self._private.public_key.format(compressed=True)[1:].hex()

    def sign(self, digest: bytes) -> bytes:
        """BIP-340 Schnorr signature over a 32-byte message."""
        return self._private.sign_schnorr(digest)

    def shared_x(self, pubkey_hex: str) -> bytes:
        """ECDH: the x coordinate of ``secret * pubkey`` (NIP-44 and NIP-04 both use it)."""
        point = PublicKey(b"\x02" + bytes.fromhex(pubkey_hex))
        return point.multiply(self.secret).format(compressed=True)[1:]


def event_id(pubkey: str, created_at: int, kind: int, tags: Tags, content: str) -> str:
    """sha256 of the NIP-01 serialization ``[0, pubkey, created_at, kind, tags, content]``."""
    serialized = json.dumps(
        [0, pubkey, created_at, kind, tags, content],
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def sign_event(
    keypair: KeyPair,
    kind: int,
    tags: Tags,
    content: str,
    created_at: int | None = None,
) -> dict[str, Any]:
    """Build and sign a complete event dict."""
    stamp = int(time.time()) if created_at is None else created_at
    ident = event_id(keypair.pubkey, stamp, kind, tags, content)
    return {
        "id": ident,
        "pubkey": keypair.pubkey,
        "created_at": stamp,
        "kind": kind,
        "tags": tags,
        "content": content,
        "sig": keypair.sign(bytes.fromhex(ident)).hex(),
    }


def verify_event(event: dict[str, Any]) -> bool:
    """True when the id matches the serialization and the signature matches the author."""
    try:
        expected = event_id(
            event["pubkey"], event["created_at"], event["kind"], event["tags"], event["content"]
        )
        if expected != event["id"]:
            return False
        author = PublicKeyXOnly(bytes.fromhex(event["pubkey"]))
        return author.verify(bytes.fromhex(event["sig"]), bytes.fromhex(expected))
    except (KeyError, TypeError, ValueError):
        return False


def tag_value(event: dict[str, Any], name: str) -> str | None:
    """The second element of the first tag named ``name``, or None."""
    for tag in event.get("tags", []):
        if len(tag) >= 2 and tag[0] == name:
            return str(tag[1])
    return None
