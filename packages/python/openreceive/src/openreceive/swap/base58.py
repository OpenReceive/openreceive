"""Bitcoin/Solana base58 decoding (no dependency; the alphabet without 0OIl)."""

from __future__ import annotations

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_INDEX = {character: index for index, character in enumerate(ALPHABET)}


def decode(value: str) -> bytes | None:
    """Decoded bytes, or None on an invalid character. Leading "1" characters
    are leading zero bytes (matches the JS decodeBase58, including the
    all-'1' zero-value input)."""
    if not value:
        return None
    number = 0
    for character in value:
        digit = _INDEX.get(character)
        if digit is None:
            return None
        number = number * 58 + digit
    body = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    leading_zeros = len(value) - len(value.lstrip("1"))
    return b"\x00" * leading_zeros + body
