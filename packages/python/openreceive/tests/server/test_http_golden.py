"""Every spec/test-vectors/http-golden/*.json file against the framework-free
handler: status, the headers the vector names, and the FULL body (key set AND
values). Placeholder strings assert "present and matching this pattern" for
values that legitimately differ per run; the matcher table is copied verbatim
from tests/http-boundaries.test.mjs (and the Ruby server_test.rb) — change
all of them together. Follow-up: promote the table to
spec/test-vectors/http-golden/PLACEHOLDERS.json so every engine reads one file."""

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

GOLDEN_PLACEHOLDERS = {
    "<request_id>": lambda value: (
        isinstance(value, str)
        and re.fullmatch(r"req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", value)
        is not None
    ),
    "<payment_hash>": lambda value: (
        isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None
    ),
    "<bolt11>": lambda value: isinstance(value, str) and value.startswith("ln"),
    "<unix_seconds>": lambda value: (
        isinstance(value, int) and not isinstance(value, bool) and value >= 0
    ),
}


def assert_golden_value(actual: Any, expected: Any, context: str) -> None:
    if isinstance(expected, str) and expected in GOLDEN_PLACEHOLDERS:
        assert GOLDEN_PLACEHOLDERS[expected](actual), (
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


GOLDEN_PATHS = sorted(GOLDEN_DIR.glob("*.json"))


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
    path: Path, handlers: dict[str, RequestHandler]
) -> None:
    vector = json.loads(path.read_text(encoding="utf-8"))
    assert vector["schema_version"] == 2, f"{path}: schema_version"
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
