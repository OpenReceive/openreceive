"""The paged, deduped, truncation-safe wallet-history walk
(`wallet-scan-truncation` vectors). Twin of Ruby `OpenReceive::Payments` and
the JS core `listIncomingTransactions`.

A walk that ended before the wallet ran out of rows is TRUNCATED — a hash such
a walk did not see is unproven, never proven absent.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from openreceive._generated.tables import TRANSACTION_PAGE_LIMIT
from openreceive.nwc.requests import normalize_list_transactions_response
from openreceive.values import LOWER_HEX_64_PATTERN, normalize_payment_hash, to_int

MAX_PAGES = 10_000


class ListsTransactions(Protocol):
    def list_transactions(self, params: dict[str, Any]) -> Any: ...


@dataclass
class ScanResult:
    rows: dict[str, dict[str, Any]]
    truncated: bool


def list_incoming_transactions(
    client: ListsTransactions,
    expected: list[str],
    *,
    scan_from: int | None = None,
    scan_until: int | None = None,
    max_pages: int | None = None,
    include_unpaid: bool = False,
) -> ScanResult:
    pages = _normalize_max_pages(max_pages)
    outstanding = {normalize_payment_hash(value) for value in expected}
    rows: dict[str, dict[str, Any]] = {}
    offset = 0
    previous_page: str | None = None
    # Proven false the moment the wallet runs out of rows or every expected
    # hash is accounted for; otherwise the walk hit its cap with rows to come.
    truncated = True
    for _ in range(pages):
        request: dict[str, Any] = {
            "type": "incoming",
            "limit": TRANSACTION_PAGE_LIMIT,
            "offset": offset,
        }
        if include_unpaid:
            request["unpaid"] = True
        if scan_from is not None:
            request["from"] = _normalize_unix(scan_from, "from")
        if scan_until is not None:
            request["until"] = _normalize_unix(scan_until, "until")
        page = normalize_list_transactions_response(client.list_transactions(request))[
            "transactions"
        ]
        for row in page:
            if row.get("type") not in (None, "incoming"):
                continue
            payment_hash = _row_payment_hash(row)
            if payment_hash is None:
                continue
            rows[payment_hash] = row
            outstanding.discard(payment_hash)
        if not outstanding or len(page) < TRANSACTION_PAGE_LIMIT:
            truncated = False
            break
        # A wallet that ignores `offset` serves the same page forever; stop
        # instead of paging to the cap, and keep the scan marked incomplete.
        page_key = ",".join(str(row.get("payment_hash", "")) for row in page)
        if page_key == previous_page:
            break
        previous_page = page_key
        offset += TRANSACTION_PAGE_LIMIT
    return ScanResult(rows=rows, truncated=truncated)


def _normalize_max_pages(value: int | None) -> int:
    if value is None:
        return MAX_PAGES
    pages = to_int(value)
    if pages <= 0:
        raise ValueError("max_pages must be a positive integer")
    return pages


def _row_payment_hash(row: dict[str, Any]) -> str | None:
    """The scan key for one wallet row, or None when the row can never match
    an attempt — skipped rather than rejected, so one quirky row cannot
    livelock reconciliation."""
    payment_hash = str(row.get("payment_hash") or "").strip().lower()
    return payment_hash if LOWER_HEX_64_PATTERN.match(payment_hash) else None


def _normalize_unix(value: object, field: str) -> int:
    number = to_int(value)
    if number < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return number
