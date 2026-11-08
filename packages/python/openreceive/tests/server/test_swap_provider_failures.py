"""A swap provider call that fails reaches the payer as the 502/503 the swap
routes declare (the JS throughProvider), never the opaque 500 "Internal server
error.": a refused /create, a provider 429 or outage, and this process's own
weight budget, which a payer pressing Try again a few times spends."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine

from openreceive.server import Host, HttpRequest, OpenReceiveApp, Service
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.swap.budget import WeightBudgetError
from openreceive.swap.fixedfloat import (
    FixedFloatApiError,
    FixedFloatProvider,
    classify_transport_failure,
)
from openreceive.testing import FakeWallet

REFERENCE = "order-swap"
ORDER = {
    "id": "fixture-order",
    "token": "fixture-private-token",
    "status": "NEW",
    "from": {"address": "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", "amount": "1.05"},
    "time": {"expiration": 1_700_001_000},
}
REFUSED = {"status": 200, "body": json.dumps({"code": 1, "msg": "Order could not be created"})}
OK = {"status": 200, "body": json.dumps({"code": 0, "msg": "OK", "data": ORDER})}


class Shop:
    """The real FixedFloat provider over a scripted transport, behind the
    storage-aware app, with the weight budget the service attaches."""

    def __init__(self, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
        self.now = 1_700_000_000
        self.answers: dict[str, Any] = {"create": OK, "order": OK, "price": OK}
        self.calls: list[str] = []
        self.provider = FixedFloatProvider(
            key="synthetic-key", secret="synthetic-secret", http=self._transport
        )
        self.provider._resolve_currencies = lambda: {  # type: ignore[method-assign]
            "pay_in": {"USDT_TRON": {"code": "USDTTRC"}},
            "lightning": {"code": "BTCLN"},
        }
        engine = create_engine(f"sqlite:///{tmp_path / 'swaps.sqlite3'}")
        self.repository = SqlPaymentRepository(engine, clock=lambda: self.now)
        self.repository.create_tables()
        caplog.set_level(logging.WARNING, logger="openreceive-test")
        self.service = Service(
            FakeWallet(clock=lambda: self.now),
            price_provider=False,
            swap_providers=[self.provider],
            clock=lambda: self.now,
            logger=logging.getLogger("openreceive-test"),
        )
        self.app = OpenReceiveApp(
            service=self.service,
            host=Host(
                amount_for=lambda reference: {"sats": 20_000},
                authorize=lambda context: True,
                on_paid=lambda payment: None,
            ),
            repository=self.repository,
            rate_limiting=False,
            clock=lambda: self.now,
        )

    def _transport(self, **request: Any) -> dict[str, Any]:
        path = request["url"].rsplit("/", 1)[-1]
        self.calls.append(path)
        answer = self.answers[path]
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def post(self, route: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        raw = json.dumps(body).encode()
        status, payload, _ = self.app.handle(
            HttpRequest(
                method="POST",
                path=f"/openreceive{route}",
                headers={"content-type": "application/json"},
                body=raw,
                content_length=len(raw),
                remote_addr="203.0.113.9",
            )
        )
        return status, payload

    def create_swap(self) -> tuple[int, dict[str, Any]]:
        return self.post("/swaps", {"reference": REFERENCE, "pay_in_asset": "USDT_TRON"})


@pytest.fixture
def shop(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> Shop:
    return Shop(tmp_path, caplog)


def test_a_refused_create_is_a_502_with_the_payer_sentence(
    shop: Shop, caplog: pytest.LogCaptureFixture
) -> None:
    shop.answers["create"] = REFUSED
    status, body = shop.create_swap()
    assert status == 502, body
    assert body["code"] == "INTERNAL"
    assert body["message"] == "The swap provider refused this request."
    assert "retryable" not in body
    # The invoice minted for the swap is withheld: no attempt row exists.
    assert shop.repository.list_for_reference(REFERENCE) == []
    # The operator still reads the provider's own words; the payer never does.
    assert "Order could not be created" in caplog.text
    assert "Order could not be created" not in json.dumps(body)


def test_the_weight_budget_after_a_few_try_agains_is_a_retryable_503(shop: Shop) -> None:
    shop.answers["create"] = REFUSED
    # Each Try again spends a create weight (50) before the provider answers:
    # three refusals fill the 150 gate, and the fourth press never reaches it.
    for _ in range(3):
        assert shop.create_swap()[0] == 502
    creates = shop.calls.count("create")
    status, body = shop.create_swap()
    assert status == 503, body
    assert body["code"] == "INTERNAL"
    assert body["message"] == "The swap provider is rate limited. Please try again shortly."
    assert body["retryable"] is True
    assert shop.calls.count("create") == creates
    # The window rolls after a minute and the payer's next press is served.
    shop.answers["create"] = OK
    shop.now += 60
    status, body = shop.create_swap()
    assert status == 201, body


@pytest.mark.parametrize(
    ("answer", "message"),
    [
        (
            {"status": 429, "body": json.dumps({"code": 429, "msg": "Too many requests"})},
            "The swap provider is rate limited. Please try again shortly.",
        ),
        (
            {"status": 502, "body": "bad gateway"},
            "The swap provider is temporarily unreachable. Please try again shortly.",
        ),
        (
            ConnectionRefusedError("connection refused"),
            "The swap provider is temporarily unreachable. Please try again shortly.",
        ),
        (
            TimeoutError("timed out"),
            "The swap provider is temporarily unreachable. Please try again shortly.",
        ),
    ],
)
def test_a_provider_outage_or_429_is_a_retryable_503(shop: Shop, answer: Any, message: str) -> None:
    shop.answers["create"] = answer
    status, body = shop.create_swap()
    assert status == 503, body
    assert body == {**body, "code": "INTERNAL", "message": message, "retryable": True}


def test_status_and_refund_calls_map_the_same_way(shop: Shop) -> None:
    status, body = shop.create_swap()
    assert status == 201, body
    payment_hash = body["swap"]["payment_hash"]
    shop.answers["order"] = REFUSED
    status, body = shop.post(
        "/swaps/status", {"reference": REFERENCE, "payment_hash": payment_hash}
    )
    assert status == 502 and body["message"] == "The swap provider refused this request."
    shop.answers["order"] = {"status": 503, "body": ""}
    status, body = shop.post(
        "/swaps/refunds",
        {
            "reference": REFERENCE,
            "payment_hash": payment_hash,
            "refund_address": "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
        },
    )
    assert status == 503 and body["retryable"] is True


def test_classify_transport_failure_matches_the_js_classes() -> None:
    def api(kind: str, status: int | None = None) -> FixedFloatApiError:
        return FixedFloatApiError(path="create", kind=kind, message="x", http_status=status)

    assert classify_transport_failure(WeightBudgetError("budget", {})) == "rate_limited"
    assert classify_transport_failure(api("rate_limited", 429)) == "rate_limited"
    for kind in ("timeout", "network", "invalid_json"):
        assert classify_transport_failure(api(kind)) == "unreachable"
    assert classify_transport_failure(api("http", 500)) == "unreachable"
    assert classify_transport_failure(api("http", 400)) == "refused"
    assert classify_transport_failure(api("api")) == "refused"
    # Not a provider transport failure: the handler's opaque 500 stays.
    assert classify_transport_failure(RuntimeError("bug")) is None
