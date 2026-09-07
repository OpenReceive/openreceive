"""Terminal-transition decisions for one non-settled reconciliation result
(`attempt-reconciliation` vectors). Closure of an unpaid attempt requires a
successful wallet scan observed at or after expiry plus the grace window — a
local clock alone never closes a row. Twin of Ruby
`OpenReceive::Server::Reconciliation`.
"""

from __future__ import annotations

from typing import Any

from openreceive._generated.tables import ATTEMPT_EXPIRY_GRACE_SECONDS as _GRACE
from openreceive.values import to_int

# Seconds past an attempt's expiry during which reconciliation still scans for
# a settlement before closing the attempt. A kernel constant, never an
# environment variable (AGENTS.md).
ATTEMPT_EXPIRY_GRACE_SECONDS: int = _GRACE


def transition(
    *,
    expires_at: object,
    status: str,
    observed_at: object,
    transaction_state: str | None = None,
) -> dict[str, Any] | None:
    """{status, reason} to persist, or None to keep the attempt pending.
    Settled results never reach this decision. `transaction_state` is the
    explicit state field on the wallet's record when the scan found one; it
    decides whether a pending result past expiry+grace is an operator-attention
    case or an abandoned invoice."""
    kind = str(status)
    if kind == "failed":
        return {"status": "failed", "reason": "wallet_reported_failed"}
    if kind == "expired":
        return {"status": "expired", "reason": "wallet_reported_expired"}
    if kind in ("not_found", "pending"):
        if to_int(observed_at) < to_int(expires_at) + ATTEMPT_EXPIRY_GRACE_SECONDS:
            return None
        if kind == "not_found":
            return {"status": "expired", "reason": "not_found_after_expiry"}
        if str(transaction_state) in ("pending", "accepted"):
            # `attention` requires the wallet's EXPLICIT claim that the
            # transaction is still in flight long after expiry.
            return {"status": "attention", "reason": "unsettled_after_expiry"}
        # A state-less record is indistinguishable from an abandoned invoice.
        return {"status": "expired", "reason": "no_finality_after_expiry"}
    raise ValueError(f"unexpected reconciliation status: {status}")
