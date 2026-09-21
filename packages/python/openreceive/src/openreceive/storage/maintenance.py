"""Explicit host/operator repair decisions; never called from a mounted route."""

from __future__ import annotations

import re
from typing import Any

from openreceive.storage.repository import PaymentRecord, settlement_expires_at


def repair_candidate(record: PaymentRecord, updated_at: int) -> dict[str, Any] | None:
    wallet_expiry = settlement_expires_at(record.checkout, record.payment_hash)
    reason = None
    if record.status == "attention":
        reason = "operator_attention"
    if (
        record.is_swap
        and record.status in ("expired", "attention")
        and record.status_reason
        in ("not_found_after_expiry", "no_finality_after_expiry", "unsettled_after_expiry")
        and wallet_expiry > record.expires_at
        and record.expires_at + 900 <= updated_at < wallet_expiry + 900
    ):
        reason = "early_deposit_deadline_closure"
    if reason is None:
        return None
    return {
        "reference": record.reference,
        "payment_hash": record.payment_hash,
        "status": record.status,
        "status_reason": record.status_reason,
        "updated_at": updated_at,
        "instruction_expires_at": record.expires_at,
        "wallet_expires_at": wallet_expiry,
        "reason": reason,
    }


def repair_decision(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,120}", value):
        raise ValueError(
            "decision_id must be a nonsecret operator ticket identifier (letters, digits, . _ : -)."
        )
    return value
