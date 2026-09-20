"""Every spec/test-vectors/http-golden/*.json file against the framework-free
handler: status, the headers the vector names, and the FULL body (key set AND
values). Placeholder strings assert "present and matching this pattern" for
values that legitimately differ per run. Shared predicates live in
spec/test-vectors/http-golden/PLACEHOLDERS.json."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from openreceive.server.errors import ConflictError
from openreceive.server.handler import HttpRequest, RequestHandler
from openreceive.server.service import Service
from openreceive.testing import FakeWallet
from tests.conftest import VECTORS_DIR

GOLDEN_DIR = VECTORS_DIR / "http-golden"

GOLDEN_RULES = json.loads((GOLDEN_DIR / "PLACEHOLDERS.json").read_text())


def matches_placeholder(value: Any, rule: dict[str, Any]) -> bool:
    if rule["type"] == "integer":
        return isinstance(value, int) and not isinstance(value, bool) and value >= rule["minimum"]
    return isinstance(value, str) and (
        value.startswith(rule["prefix"])
        if "prefix" in rule
        else re.fullmatch(rule["pattern"], value) is not None
    )


def assert_golden_value(actual: Any, expected: Any, context: str) -> None:
    if isinstance(expected, str) and expected in GOLDEN_RULES:
        assert matches_placeholder(actual, GOLDEN_RULES[expected]), (
            f"{context}: {actual!r} does not satisfy {expected}"
        )
    elif isinstance(expected, list):
        assert isinstance(actual, list), f"{context}: expected an array"
        assert len(actual) == len(expected), f"{context}: array length"
        for index, item in enumerate(expected):
            assert_golden_value(actual[index], item, f"{context}[{index}]")
    elif isinstance(expected, dict):
        assert isinstance(actual, dict), f"{context}: expected an object"
        assert sorted(actual) == sorted(expected), f"{context}: key set"
        for key, item in expected.items():
            assert_golden_value(actual[key], item, f"{context}.{key}")
    else:
        assert actual == expected, f"{context}: value"


SETTLED_HASH = "7f" * 32
# Deterministic settled attempt behind the settled_check vector: the wallet
# row deliberately carries the preimage and raw invoice, and the vector's
# exact key-set assertion proves neither leaks into the payer-polled body.
SETTLED_ROW = {
    "type": "incoming",
    "invoice": "lnbcgoldensettled",
    "payment_hash": SETTLED_HASH,
    "amount_msats": 1000,
    "transaction_state": "settled",
    "created_at": 900,
    "expires_at": 1500,
    "settled_at": 950,
    "preimage": "1" * 64,
}
SETTLED_CHECKOUT = {
    "reference": "order-golden-settled",
    "payment_hash": SETTLED_HASH,
    "bolt11": "lnbcgoldensettled",
    "amount_msats": 1000,
    "created_at": 900,
    "expires_at": 1500,
    "fiat_quote": None,
}


class SettledWallet:
    def make_invoice(self, params: dict[str, Any]) -> dict[str, Any]:
        raise AssertionError("the settled_check golden handler mints nothing")

    def list_transactions(self, params: dict[str, Any]) -> dict[str, Any]:
        return {"transactions": [SETTLED_ROW]}


def build_handler(service: Service, **overrides: Any) -> RequestHandler:
    options: dict[str, Any] = {
        "service": service,
        "authorize": lambda context: True,
        "resolve_checkout": lambda **context: {"amount": {"sats": 1}},
        "on_checkout_created": lambda **payment: None,
        "on_paid": lambda payment: None,
    }
    options.update(overrides)
    return RequestHandler(**options)


@pytest.fixture(scope="module")
def handlers() -> dict[str, RequestHandler]:
    service = Service(
        FakeWallet(clock=lambda: 1000), price_provider=False, swap_providers=[], clock=lambda: 1000
    )
    settled_service = Service(
        SettledWallet(), price_provider=False, swap_providers=[], clock=lambda: 1000
    )

    def live_conflict(**payment: Any) -> None:
        # A repository refusing a second live attempt on the same rail: ONE
        # agreed string across engines.
        raise ConflictError(
            "An unpaid checkout for this payment method is already in progress for this reference."
        )

    return {
        "default": build_handler(service),
        "hook_refused": build_handler(
            service,
            on_checkout_created=lambda **_: (_ for _ in ()).throw(RuntimeError("host declined")),
        ),
        "rate_limited": build_handler(service, rate_limit=lambda context: False),
        "settled_check": build_handler(
            settled_service,
            resolve_checkout=lambda **context: {
                "amount": {"sats": 1},
                "payment_hash": SETTLED_HASH,
                "checkout": SETTLED_CHECKOUT,
            },
        ),
        "live_attempt_conflict": build_handler(service, on_checkout_created=live_conflict),
        "described": build_handler(
            service,
            resolve_checkout=lambda **context: {
                "amount": {"sats": 1},
                "description": "2 kg Ataulfo mangoes",
            },
        ),
    }


GOLDEN_PATHS = sorted(
    path for path in GOLDEN_DIR.glob("*.json") if path.name != "PLACEHOLDERS.json"
)


def golden_request(request: dict[str, Any]) -> HttpRequest:
    if "body_bytes" in request:
        body = b"x" * int(request["body_bytes"])
    elif "body" in request:
        body = json.dumps(request["body"]).encode("utf-8")
    else:
        body = b""
    path, _, query = request["path"].partition("?")
    headers = {"content-type": request.get("content_type", "application/json")}
    headers.update(
        {str(name).lower(): str(value) for name, value in (request.get("headers") or {}).items()}
    )
    return HttpRequest(
        method=request["method"],
        path=path,
        query_string=query,
        headers=headers,
        body=body,
        content_length=len(body),
        remote_addr="203.0.113.9",
    )


def test_there_are_golden_vectors() -> None:
    assert GOLDEN_PATHS, "no http-golden vectors found"


@pytest.mark.parametrize("path", GOLDEN_PATHS, ids=lambda path: Path(path).stem)
def test_handler_satisfies_http_golden_vector(
    path: Path, handlers: dict[str, RequestHandler], tmp_path: Path
) -> None:
    vector = json.loads(path.read_text(encoding="utf-8"))
    assert vector["schema_version"] == 2, f"{path}: schema_version"
    if vector.get("handler", "").startswith("repository_"):
        status, body, headers = repository_response(vector, tmp_path)
    else:
        handler = handlers[vector.get("handler", "default")]
        status, body, headers = handler.dispatch(golden_request(vector["request"]))
    name = vector["name"]
    assert status == vector["expected"]["status"], f"{name}: status {status} body {body}"
    for header, value in (vector["expected"].get("headers") or {}).items():
        actual = next(
            (item for key, item in headers.items() if key.lower() == header.lower()), None
        )
        assert_golden_value(actual, value, f"{name}: header {header}")
    # The whole wire body, not a code sample.
    assert_golden_value(json.loads(json.dumps(body)), vector["expected"]["body"], f"{name}: body")


def build_repository_app(vector, repository, on_paid):
    """One host contract for the SQL and mounted Django golden consumers."""
    from openreceive.server import Host, OpenReceiveApp
    from openreceive.storage import PaymentInsert, SettlementRecord

    kind = vector["handler"]
    provider_order = vector.get("setup", {}).get("provider_order")

    class Provider:
        name = "fixedfloat"
        state = "refund_required"

        def get_status(self, order):
            assert order["provider_token"] == provider_order["provider_token"]
            return {**order, "state": self.state}

        def request_refund(self, order, address):
            assert order["provider_token"] == provider_order["provider_token"]
            self.state = "refund_pending"

    wallet = FakeWallet(clock=lambda: 1000)
    if kind == "repository_failed_settlement":
        wallet.list_transactions = lambda _: {"transactions": [SETTLED_ROW]}
    service = Service(
        wallet,
        price_provider=False,
        swap_providers=[Provider()] if provider_order else [],
        clock=lambda: 1000,
    )
    repository.commit_attempt(
        PaymentInsert(
            SETTLED_CHECKOUT["reference"],
            SETTLED_HASH,
            SETTLED_CHECKOUT,
            swap_data={"version": 1, "provider_order": provider_order} if provider_order else None,
        )
    )
    if kind == "repository_gate_busy":
        repository.record_settlement(SettlementRecord(SETTLED_HASH, 950), on_paid)
        extra = {**SETTLED_CHECKOUT, "reference": "pending-gate", "payment_hash": "8f" * 32}
        repository.commit_attempt(PaymentInsert("pending-gate", extra["payment_hash"], extra))
        assert repository.claim_reconcile_gate(now=1000, interval_seconds=2) is not None
        wallet.list_transactions = lambda _: (_ for _ in ()).throw(
            AssertionError("gate loser scanned")
        )
    return OpenReceiveApp(
        service=service,
        repository=repository,
        host=Host(amount_for=lambda _: {"sats": 1}, authorize=lambda _: True, on_paid=on_paid),
        rate_limiting=False,
        clock=lambda: 1000,
    )


def assert_repository_effects(vector, repository, body, fulfilled_count):
    kind = vector["handler"]
    record = repository.find_by_payment_hash(SETTLED_HASH)
    if kind == "repository_failed_settlement":
        assert record.status == "pending"
        assert fulfilled_count == 0
    provider_order = vector.get("setup", {}).get("provider_order")
    if provider_order:
        assert (
            record.swap_data["provider_order"]["provider_token"] == provider_order["provider_token"]
        )
        assert provider_order["provider_token"] not in json.dumps(body)


def repository_response(vector, tmp_path):
    from sqlalchemy import create_engine, text

    from openreceive.storage.sql import SqlPaymentRepository

    engine = create_engine(f"sqlite:///{tmp_path / 'golden.sqlite3'}")
    repository = SqlPaymentRepository(engine, clock=lambda: 1000)
    repository.create_tables()
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE fulfilled (reference TEXT PRIMARY KEY)"))

        def on_paid(payment):
            payment.connection.execute(
                text("INSERT INTO fulfilled VALUES (:reference)"), {"reference": payment.reference}
            )
            if vector["handler"] == "repository_failed_settlement":
                raise RuntimeError("host rollback fixture")

        app = build_repository_app(vector, repository, on_paid)
        if vector["handler"] == "repository_failed_create":
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "CREATE TRIGGER fail_attempt BEFORE INSERT ON openreceive_payments BEGIN SELECT RAISE(ABORT, 'storage fixture'); END"
                    )
                )
        response = app.handle(golden_request(vector["request"]))
        with engine.connect() as connection:
            fulfilled_count = connection.execute(text("SELECT COUNT(*) FROM fulfilled")).scalar()
        assert_repository_effects(vector, repository, response.body, fulfilled_count)
        return response
    finally:
        engine.dispose()
