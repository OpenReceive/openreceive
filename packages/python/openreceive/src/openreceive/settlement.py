"""The settlement classification rule (`settlement-detection` vectors):
settled requires `settled_at > 0` or a settled state; a preimage alone is
corroborating evidence, never proof. Twin of Ruby `OpenReceive::Settlement`.
"""

from __future__ import annotations

from typing import Any

from openreceive.values import stringify


def _state_is(data: dict[str, Any], expected: str) -> bool:
    # Raw wallet states compare case-insensitively (the JS isTransactionState rule).
    return any(
        isinstance(value, str) and value.lower() == expected
        for value in (data.get("state"), data.get("transaction_state"))
    )


def _settled_at_positive(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return value > 0
    if isinstance(value, str):
        try:
            return int(value.strip()) > 0
        except ValueError:
            return False
    return False


def is_settled(transaction: object) -> bool:
    data = stringify(transaction)
    return _settled_at_positive(data.get("settled_at")) or _state_is(data, "settled")


def status(transaction: object) -> str:
    """One of settled | expired | failed | pending."""
    data = stringify(transaction)
    if is_settled(data):
        return "settled"
    if _state_is(data, "expired"):
        return "expired"
    if _state_is(data, "failed"):
        return "failed"
    return "pending"
