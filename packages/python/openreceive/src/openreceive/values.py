"""Small value helpers shared by every module: string-keyed dict views over
wire payloads, integer coercion, and the 64-hex payment-hash rule.

Wire payloads reach the engine as JSON dicts (string keys) or as values a host
built by hand. `stringify` tolerates a non-mapping and returns {} — use it on
anything a third party supplied; `as_string_keys` does not — use it where the
caller has already proven the value is a mapping.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

HEX_64_PATTERN = re.compile(r"\A[0-9a-fA-F]{64}\Z")
LOWER_HEX_64_PATTERN = re.compile(r"\A[0-9a-f]{64}\Z")


def stringify(value: object) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return as_string_keys(value)
    return {}


def as_string_keys(value: Mapping[Any, Any]) -> dict[str, Any]:
    return {str(key): item for key, item in value.items()}


def to_int(value: object) -> int:
    """Ruby's Integer(): ints, integral floats, and integral decimal strings."""
    if isinstance(value, bool):
        raise TypeError("booleans are not integers")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")) or value != int(value):
            raise ValueError(f"{value!r} is not an integer")
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if re.fullmatch(r"[+-]?[0-9]+", text) is None:
            raise ValueError(f"{value!r} is not an integer")
        return int(text, 10)
    raise TypeError(f"{value!r} is not an integer")


def optional_int(value: object) -> int | None:
    return None if value is None else to_int(value)


def compact(mapping: Mapping[str, Any]) -> dict[str, Any]:
    """Drop None values (Ruby's Hash#compact)."""
    return {key: item for key, item in mapping.items() if item is not None}


def present(value: object) -> bool:
    return value is not None and value != ""


def normalize_payment_hash(value: object) -> str:
    normalized = str(value if value is not None else "").strip().lower()
    if LOWER_HEX_64_PATTERN.match(normalized) is None:
        raise ValueError("payment_hash must be 64 hexadecimal characters")
    return normalized
