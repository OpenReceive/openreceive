#!/usr/bin/env python3
"""Storage-free cross-language conformance for the Python engine — the twin of
tools/conformance/ruby-crosslang.rb. Every family under spec/test-vectors runs
against the PRODUCTION functions of `openreceive` (never a re-implementation);
the first drift raises. Run through `tools/ci/python-tests.sh` (`npm run
test:python`), which puts the package's uv environment on the path."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages" / "python" / "openreceive" / "src"))

from openreceive import money, settlement  # noqa: E402
from openreceive.nwc import errors as nwc_errors  # noqa: E402
from openreceive.nwc import info as wallet_info  # noqa: E402
from openreceive.nwc import requests as nwc_requests  # noqa: E402
from openreceive.nwc.uri import NwcUriParseError, parse_uri  # noqa: E402
from openreceive.payments import reconciliation  # noqa: E402
from openreceive.server.service import Service  # noqa: E402
from openreceive.storage.sql import repository as sql_repository  # noqa: E402
from openreceive.swap import address, lsc_uri  # noqa: E402
from openreceive.swap.fixedfloat import FixedFloatProvider  # noqa: E402


def vector(name: str) -> Any:
    with (ROOT / "spec" / "test-vectors" / f"{name}.json").open(encoding="utf-8") as handle:
        return json.load(handle)


def fail(message: str) -> None:
    raise SystemExit(f"python conformance failed: {message}")


# fiat-to-msats: every quote case must match the shared ceil-to-whole-sat rule.
fiat = vector("fiat-to-msats.usd")
for case in fiat["cases"]:
    msats = money.quote_fiat_to_msats(case["fiat"]["value"], fiat["btc_fiat_price"])
    if msats != case["expected"]["amount_msats"]:
        fail(f"fiat-to-msats parity: {case['name']} (got {msats})")
for case in fiat.get("invalid_cases", []):
    try:
        got = money.quote_fiat_to_msats(case["fiat"]["value"], fiat["btc_fiat_price"])
    except (ValueError, TypeError):
        pass
    else:
        fail(f"fiat-to-msats parity: {case['name']} was accepted (got {got})")

# amount-boundaries: bounded msats acceptance must match exactly.
for case in vector("amount-boundaries")["cases"]:
    try:
        money.bounded_msats(case["amount_msats"])
        valid = True
    except (ValueError, TypeError):
        valid = False
    if valid != case["valid"]:
        fail(f"amount-boundaries parity: {case['name']}")

# rate-limit-window: the per-IP budget windows on the same immutable column.
rate_limit = vector("rate-limit-window")
if rate_limit["column"] != "inserted_at":
    fail(f"rate-limit-window parity: unexpected column {rate_limit['column']}")
repository_source = Path(sql_repository.__file__).read_text(encoding="utf-8")
counting = repository_source[repository_source.index("def count_attempts_from_ip") :]
counting = counting[: counting.index("def ", 10)]
if f"payments.c.{rate_limit['column']} >=" not in counting:
    fail(f"rate-limit-window parity: the SQL repository does not count on {rate_limit['column']}")
for case in rate_limit["cases"]:
    stamp = case["attempt"][rate_limit["column"]]
    counted = stamp >= case["now"] - case["window_seconds"]
    if counted != case["expected"]["counted"]:
        fail(f"rate-limit-window parity: {case['name']}")

# swap-address: a checksum, not a shape guard.
for case in vector("swap-address")["cases"]:
    actual = address.valid_for_network(case["network"], case["address"])
    if actual != case["expected"]["valid"]:
        fail(f"swap-address parity: {case['name']} (got {actual})")

# settlement-detection: the shared finality rule (never a preimage alone) and
# the 4-way classification.
for case in vector("settlement-detection")["cases"]:
    if settlement.is_settled(case["transaction"]) != case["expected"]["settled"]:
        fail(f"settlement-detection parity: {case['name']}")
    expected_status = case["expected"].get("status")
    if expected_status is not None and settlement.status(case["transaction"]) != expected_status:
        fail(f"settlement-detection parity: {case['name']} (status)")

# make-invoice-validation: request validation before any wallet call.
for case in vector("make-invoice-validation")["cases"]:
    request = dict(case["request"])
    if "metadata_note_length" in request:
        request["metadata"] = {"note": "x" * request.pop("metadata_note_length")}
    try:
        nwc_requests.make_invoice_request(request)
        valid = True
    except (ValueError, KeyError, TypeError):
        valid = False
    if valid != case["expected"]["valid"]:
        fail(f"make-invoice-validation parity: {case['name']}")

# nwc-request-response: NIP-47 request mapping and response normalization.
for case in vector("nwc-request-response")["cases"]:
    if case["method"] == "make_invoice":
        actual_request = nwc_requests.make_invoice_request(case["openreceive_request"])
        if actual_request != case["expected_nip47_request"]:
            fail(f"nwc-request-response parity: {case['name']} request (got {actual_request!r})")
        if "expected_openreceive_response" in case:
            actual = nwc_requests.normalize_make_invoice_response(case["raw_response"])
            for key, value in case["expected_openreceive_response"].items():
                if actual.get(key) != value:
                    fail(f"nwc-request-response parity: {case['name']} response {key}")
    else:
        actual_request = nwc_requests.list_transactions_request(case["openreceive_request"])
        if actual_request != case["expected_nip47_request"]:
            fail(f"nwc-request-response parity: {case['name']} request (got {actual_request!r})")
        if "expected_openreceive_response" in case:
            actual = nwc_requests.normalize_list_transactions_response(case["raw_response"])
            expected = case["expected_openreceive_response"]
            if len(actual["transactions"]) != len(expected["transactions"]):
                fail(f"nwc-request-response parity: {case['name']} row count")
            for index, row in enumerate(expected["transactions"]):
                for key, value in row.items():
                    if actual["transactions"][index].get(key) != value:
                        fail(f"nwc-request-response parity: {case['name']} row {index} {key}")

# nwc-info: capabilities, encryption mode, spend detection, receive readiness.
for case in vector("nwc-info")["cases"]:
    summary = wallet_info.summarize(case["raw_info"])
    expected = case["expected"]
    warned = [
        match.group(1)
        for match in (re.search(r"'([^']+)'", warning) for warning in summary["warnings"])
        if match is not None
    ]
    checks = {
        "methods": summary["methods"] == expected["methods"],
        "encryption": summary["encryption"] == expected["encryption"],
        "spend_capability_advertised": summary["spend_capability_advertised"]
        == expected["spend_capability_advertised"],
        "receive_checkout_ready": summary["receive_checkout_ready"]
        == expected["receive_checkout_ready"],
        "warning_methods": warned == expected["warning_methods"],
    }
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        fail(f"nwc-info parity: {case['name']} ({', '.join(failed)})")

# nwc-uri-parse: identical parse results and error codes.
for case in vector("nwc-uri-parse")["cases"]:
    if "expected_error" in case:
        try:
            parse_uri(case["uri"])
        except NwcUriParseError as error:
            if error.code != case["expected_error"]:
                fail(f"nwc-uri-parse parity: {case['name']} raised {error.code}")
        else:
            fail(f"nwc-uri-parse parity: {case['name']} did not raise")
    else:
        parsed = parse_uri(case["uri"])
        expected = case["expected"]
        checks = {
            "wallet_pubkey": parsed.wallet_pubkey == expected["wallet_pubkey"],
            "relays": list(parsed.relays) == expected["relays"],
            "secret_present": bool(parsed.client_secret) == expected["secret_present"],
            "lud16": parsed.lud16 == expected.get("lud16"),
            "redacted": parsed.redacted == expected["redacted"],
        }
        failed = [name for name, ok in checks.items() if not ok]
        if failed:
            fail(f"nwc-uri-parse parity: {case['name']} ({', '.join(failed)})")

# error-normalization: wallet failures map to canonical codes + retryable.
for case in vector("error-normalization")["cases"]:
    actual = nwc_errors.normalize_wallet_error(case["raw_error"])
    for key, value in case["expected"].items():
        if actual.get(key) != value:
            fail(
                f"error-normalization parity: {case['name']} {key} (expected {value!r}, got {actual.get(key)!r})"
            )

# swap-state: through the production normalizer (the generated table's interpreter).
swap_state = vector("swap-state")
if swap_state["provider"] != "fixedfloat":
    fail("swap-state parity: unexpected provider")
for case in swap_state["cases"]:
    actual = FixedFloatProvider.normalize_status(
        case["status"],
        case.get("emergency", {}),
        "refund-tx" if case["refund_tx_present"] else None,
    )
    if actual != case["expected"]:
        fail(f"swap-state parity: {case['name']} (expected {case['expected']!r}, got {actual!r})")

# lsc-uri: parse expectations and refusals.
lsc = vector("lsc-uri")
for case in lsc["valid"]:
    if lsc_uri.parse(case["uri"]) != case["expected"]:
        fail(f"lsc-uri parity: {case['name']}")
for case in lsc["invalid"]:
    try:
        lsc_uri.parse(case["uri"])
    except lsc_uri.LscUriError:
        pass
    else:
        fail(f"lsc-uri parity: {case['name']} was accepted")

if money.quote_fiat_to_msats("10.00", "50000.00") != 20_000_000:
    fail("fiat parity")

# wallet-scan-truncation: a walk cut short must OMIT unmatched hashes.
scan_family = vector("wallet-scan-truncation")
scan_page_limit = scan_family["page_limit"]


def scan_filler_row(page: int, index: int) -> dict[str, Any]:
    return {
        "type": "incoming",
        "payment_hash": "f" * 56 + f"{page * 10_000 + index:08d}",
        "amount_msats": 1000,
        "transaction_state": "settled",
        "created_at": 1000,
        "settled_at": 1100,
    }


def scan_build_pages(specs: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    pages: list[list[dict[str, Any]]] = []
    for page, spec in enumerate(specs):
        rows = [dict(row) for row in spec.get("rows", [])]
        rows.extend(
            scan_filler_row(page, index) for index in range(int(spec.get("filler_rows", 0)))
        )
        pages.append(rows)
    return pages


class ScanWallet:
    def __init__(self, spec: dict[str, Any]) -> None:
        self.pages = scan_build_pages(spec["pages"])
        self.unpaid_pages = (
            scan_build_pages(spec["unpaid_pages"]) if "unpaid_pages" in spec else self.pages
        )
        self.ignores_offset = bool(spec.get("ignores_offset"))

    def list_transactions(self, params: dict[str, Any]) -> dict[str, Any]:
        source = self.unpaid_pages if params.get("unpaid") else self.pages
        index = 0 if self.ignores_offset else int(params.get("offset", 0)) // scan_page_limit
        return {"transactions": source[index] if index < len(source) else []}


for case in scan_family["cases"]:
    service = Service(
        ScanWallet(case["wallet"]),
        price_provider=False,
        swap_providers=[],
        clock=lambda case=case: case["clock"],
    )
    payload: dict[str, Any] = {"attempts": case["attempts"]}
    if "max_pages" in case:
        payload["max_pages"] = case["max_pages"]
    results = service.reconcile_payments(payload)
    by_hash = {row["payment_hash"]: row["status"] for row in results}
    for row in case["expected"]["results"]:
        if by_hash.get(row["payment_hash"]) != row["status"]:
            fail(
                f"wallet-scan-truncation parity: {case['name']} {row['payment_hash']} (got {by_hash.get(row['payment_hash'])!r})"
            )
    for omitted in case["expected"]["omitted"]:
        if omitted in by_hash:
            fail(f"wallet-scan-truncation parity: {case['name']} {omitted} must be omitted")
    if len(results) != len(case["expected"]["results"]):
        fail(f"wallet-scan-truncation parity: {case['name']} result count (got {len(results)})")

# attempt-reconciliation: the closure decision table and the shared grace constant.
attempt_vectors = vector("attempt-reconciliation")
if reconciliation.ATTEMPT_EXPIRY_GRACE_SECONDS != attempt_vectors["expiry_grace_seconds"]:
    fail("attempt expiry grace drifted from the shared vectors")
for case in attempt_vectors["vectors"]:
    actual = reconciliation.transition(
        expires_at=case["attempt"]["expires_at"],
        status=case["status"],
        observed_at=case["observed_at"],
        transaction_state=case.get("transaction_state"),
    )
    if actual != case["expected"]:
        fail(f"reconciliation parity: {case['name']}")

print(
    "python storage-free conformance: ok (fiat, amounts, settlement, make-invoice, nwc-info, nwc-uri, "
    "errors, reconciliation, rate-limit-window, swap-address, swap-state, lsc-uri, wallet-scan-truncation)"
)
