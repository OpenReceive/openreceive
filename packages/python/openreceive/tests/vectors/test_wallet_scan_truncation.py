"""A walk cut short (page cap, deadline, or an offset-ignoring wallet) must OMIT
unmatched hashes from the reconcile results instead of reporting not_found —
closing a paid attempt a truncated scan never saw loses money. Mirrors the
same-named JS and Ruby harness tests; all engines expand filler rows identically."""

from __future__ import annotations

from typing import Any

import pytest

from openreceive.server.service import Service
from tests.conftest import load_vector

VECTOR = load_vector("wallet-scan-truncation.json")
PAGE_LIMIT = VECTOR["page_limit"]


def filler_row(page: int, index: int) -> dict[str, Any]:
    return {
        "type": "incoming",
        "payment_hash": "f" * 56 + f"{page * 10_000 + index:08d}",
        "amount_msats": 1000,
        "transaction_state": "settled",
        "created_at": 1000,
        "settled_at": 1100,
    }


def build_pages(specs: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    pages: list[list[dict[str, Any]]] = []
    for page, spec in enumerate(specs):
        rows = [dict(row) for row in spec.get("rows", [])]
        rows.extend(filler_row(page, index) for index in range(int(spec.get("filler_rows", 0))))
        pages.append(rows)
    return pages


class PagedWallet:
    def __init__(self, spec: dict[str, Any]) -> None:
        self.pages = build_pages(spec["pages"])
        self.unpaid_pages = (
            build_pages(spec["unpaid_pages"]) if "unpaid_pages" in spec else self.pages
        )
        self.ignores_offset = bool(spec.get("ignores_offset"))

    def list_transactions(self, params: dict[str, Any]) -> dict[str, Any]:
        source = self.unpaid_pages if params.get("unpaid") else self.pages
        index = 0 if self.ignores_offset else int(params.get("offset", 0)) // PAGE_LIMIT
        return {"transactions": source[index] if index < len(source) else []}


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_wallet_scan_truncation(case: dict[str, Any]) -> None:
    service = Service(
        PagedWallet(case["wallet"]),
        price_provider=False,
        swap_providers=[],
        clock=lambda: case["clock"],
    )
    payload: dict[str, Any] = {"attempts": case["attempts"]}
    if "max_pages" in case:
        payload["max_pages"] = case["max_pages"]
    results = service.reconcile_payments(payload)
    by_hash = {row["payment_hash"]: row["status"] for row in results}
    for row in case["expected"]["results"]:
        assert by_hash.get(row["payment_hash"]) == row["status"], row["payment_hash"]
    for omitted in case["expected"]["omitted"]:
        assert omitted not in by_hash, f"{omitted} must be omitted"
    assert len(results) == len(case["expected"]["results"])
