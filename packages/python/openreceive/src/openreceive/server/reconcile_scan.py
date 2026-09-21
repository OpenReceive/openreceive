"""Bounded wallet slices. Checkpoints contain identities and states, never wallet payloads."""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Callable
from typing import Any

from openreceive import settlement
from openreceive.nwc.requests import normalize_list_transactions_response


def new_window(attempts: list[dict[str, Any]], now: int, overlap: int) -> dict[str, Any]:
    trusted = all(a.get("created_at_source") == "wallet" for a in attempts)
    return {
        "attempts": attempts,
        "from": max(0, min(a["created_at"] for a in attempts) - overlap) if trusted else 0,
        "until": max(a["created_at"] for a in attempts) + overlap if trusted else None,
        "view": "default",
        "offset": 0,
        "anchor_offset": None,
        "fingerprint": None,
        "started_at": now,
        "absence_safe": True,
        "observations": {},
    }


def scan_slice(
    service: Any,
    window: dict[str, Any],
    *,
    max_pages: int,
    deadline: float,
    on_finality: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[list[dict[str, Any]], bool, bool]:
    """Returns checks, complete, stalled. A resumed offset proves positive evidence only."""
    results: dict[str, dict[str, Any]] = {}
    expected = {a["payment_hash"] for a in window["attempts"]}
    used = 0
    resumed = window["offset"] > 0 or window["view"] != "default"
    if resumed:
        # A stable last page does not prove earlier membership was unchanged.
        window["absence_safe"] = False
    anchor = window.get("anchor_offset") if resumed else None
    previous = window.get("fingerprint")
    replaying_anchor = anchor is not None
    while used < max_pages and time.monotonic() < deadline:
        offset = int(anchor) if replaying_anchor and anchor is not None else int(window["offset"])
        request = {"type": "incoming", "limit": 20, "offset": offset, "from": window["from"]}
        if window["until"] is not None:
            request["until"] = window["until"]
        if window["view"] == "inclusive":
            request["unpaid"] = True
        page = normalize_list_transactions_response(service._call_nwc("list_transactions", request))
        used += 1
        if time.monotonic() >= deadline:
            return list(results.values()), False, False
        rows = page["transactions"]
        physical = len(rows) + page.get("skipped_rows", 0)
        fingerprint = hashlib.sha256(
            json.dumps([r.get("payment_hash") for r in rows], separators=(",", ":")).encode()
        ).hexdigest()
        for row in rows:
            payment_hash = row.get("payment_hash")
            if payment_hash not in expected or row.get("type") not in (None, "incoming"):
                continue
            status = settlement.status(row)
            old = window["observations"].get(payment_hash, {})
            if old.get("status") == "settled":
                continue
            if status in ("settled", "expired", "failed"):
                results[payment_hash] = service._payment_result(payment_hash, row)
                if on_finality is not None and time.monotonic() < deadline:
                    on_finality(results[payment_hash])
            window["observations"][payment_hash] = {
                "status": status,
                "transaction_state": row.get("transaction_state"),
            }
        if replaying_anchor:
            replaying_anchor = False
            # Re-read overlapping boundary, then progress by this actual page length.
            window["offset"] = int(offset) + physical
            previous = fingerprint
            if physical:
                window["anchor_offset"] = offset
                window["fingerprint"] = fingerprint
                continue
        if physical == 0:
            if window["view"] == "default":
                window.update(view="inclusive", offset=0, anchor_offset=None, fingerprint=None)
                previous = None
                continue
            if window["absence_safe"]:
                for payment_hash in expected:
                    if payment_hash in results or window["observations"].get(payment_hash, {}).get(
                        "status"
                    ) in ("settled", "expired", "failed"):
                        continue
                    observation = window["observations"].get(payment_hash)
                    result = {
                        "payment_hash": payment_hash,
                        "status": "not_found" if observation is None else observation["status"],
                        "_coverage_started_at": window["started_at"],
                    }
                    if observation is not None:
                        result["details"] = {
                            "transaction": {"transaction_state": observation["transaction_state"]}
                        }
                    results[payment_hash] = result
            return list(results.values()), True, False
        if fingerprint == previous:
            return list(results.values()), False, True
        window["anchor_offset"] = offset
        window["fingerprint"] = fingerprint
        window["offset"] = int(offset) + physical
        previous = fingerprint
        if all(
            window["observations"].get(h, {}).get("status") in ("settled", "expired", "failed")
            for h in expected
        ):
            return list(results.values()), True, False
    return list(results.values()), False, False
