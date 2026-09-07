"""FixedFloat status + emergency block + refund-tx presence → swap state and
reasons: an INTERPRETER of spec/data/swap-state-table.json (rendered into
`_generated/tables.py`), first-match-wins (`swap-state` vectors). How to read
the rows lives once, in the JSON's how_to_read."""

from __future__ import annotations

from typing import Any

from openreceive._generated.tables import (
    SWAP_EMERGENCY_STATUS_ALIASES,
    SWAP_REFUND_REASON_ROWS,
    SWAP_STATUS_ROWS,
)

REFUND_PATH_STATES = ("refund_required", "refund_pending", "refunded")


def normalize_status(
    status: object, emergency: dict[str, Any] | None, refund_tx_id: str | None
) -> dict[str, Any]:
    normalized = str(status or "").upper()
    refund_tx_present = refund_tx_id is not None
    block = emergency or {}
    raw_choice = block.get("choice")
    choice = raw_choice.upper() if isinstance(raw_choice, str) and raw_choice else None
    row = next(
        candidate
        for candidate in SWAP_STATUS_ROWS
        if _matches(candidate, normalized, refund_tx_present, choice)
    )
    result: dict[str, Any] = {"state": row["state"]}
    if row["attention_reason"] is not None:
        result["attention"] = True
        result["attention_reason"] = row["attention_reason"]
    if row["refund_reason_from_emergency"]:
        reason = refund_reason_from_emergency_statuses(_string_list(block.get("status")))
        if reason is not None:
            result["refund_reason"] = reason
    return result


def _matches(
    candidate: dict[str, Any], status: str, refund_tx_present: bool, choice: str | None
) -> bool:
    if candidate["status"] == "*":
        contains = candidate["status_contains"]
        status_matches = contains is None or contains in status
    else:
        status_matches = candidate["status"] == status
    if not status_matches:
        return False
    tx_rule = candidate["refund_tx_present"]
    if tx_rule != "any" and tx_rule != refund_tx_present:
        return False
    choice_rule = candidate["choice"]
    if choice_rule == "any":
        return True
    return bool(choice_rule == "absent" if choice is None else choice_rule == choice)


def refund_reason_from_emergency_statuses(statuses: list[str]) -> str | None:
    present = {SWAP_EMERGENCY_STATUS_ALIASES.get(item.upper(), item.upper()) for item in statuses}
    for row in SWAP_REFUND_REASON_ROWS:
        if all(needed in present for needed in row["all_of"]):
            return str(row["refund_reason"])
    return None


def is_refund_path_state(state: object) -> bool:
    return state in REFUND_PATH_STATES


def _string_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    if isinstance(value, str) and value:
        return [value]
    return []
