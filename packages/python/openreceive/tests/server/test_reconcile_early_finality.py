"""A wallet scan may commit a payment the moment it sees one, and nothing else.

A failed or expired invoice closes only when the scan completes: a scan that
then breaks off must leave it pending, because the close rule is a successful
scan at or after expiry plus the grace window (fix 3e7782fd). The bug zoo
undid that fix in the Python engine and no test failed; this one does.
"""

from __future__ import annotations

import time
from typing import Any

from openreceive.server.reconcile_scan import new_window, scan_slice

SETTLED = "a" * 64
EXPIRED = "b" * 64
FAILED = "c" * 64
CREATED_AT = 1_700_000_000


class _Wallet:
    """The slice's view of the service: one page of incoming transactions."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def _call_nwc(self, method: str, request: dict[str, Any]) -> dict[str, Any]:
        assert method == "list_transactions"
        return {"transactions": self.rows if request["offset"] == 0 else []}

    def _payment_result(self, payment_hash: str, row: dict[str, Any]) -> dict[str, Any]:
        return {"payment_hash": payment_hash, "transaction_state": row.get("state")}


def _row(payment_hash: str, state: str, **extra: Any) -> dict[str, Any]:
    return {
        "type": "incoming",
        "payment_hash": payment_hash,
        "amount": 21_000,
        "created_at": CREATED_AT,
        "state": state,
        **extra,
    }


def test_only_a_settled_invoice_commits_before_the_scan_completes() -> None:
    attempts = [
        {"payment_hash": payment_hash, "created_at": CREATED_AT}
        for payment_hash in (SETTLED, EXPIRED, FAILED)
    ]
    window = new_window(attempts, now=CREATED_AT + 3_600, overlap=60)
    wallet = _Wallet(
        [
            _row(SETTLED, "settled", settled_at=CREATED_AT + 30, preimage="00" * 32),
            _row(EXPIRED, "expired"),
            _row(FAILED, "failed"),
        ]
    )
    committed: list[dict[str, Any]] = []

    checks, _complete, _stalled = scan_slice(
        wallet,
        window,
        max_pages=1,
        deadline=time.monotonic() + 30,
        on_finality=committed.append,
    )

    assert [result["payment_hash"] for result in committed] == [SETTLED]
    # The slice still reports all three, for the pass to apply once it completes.
    assert {check["payment_hash"] for check in checks} >= {SETTLED, EXPIRED, FAILED}
