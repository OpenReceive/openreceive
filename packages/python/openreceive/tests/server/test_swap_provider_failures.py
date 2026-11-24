"""A swap provider call that fails reaches the payer as the 502/503 the swap
routes declare (the JS throughProvider), never the opaque 500 "Internal server
error.": a refused /create, a provider 429 or outage, and this process's own
weight budget, which a payer pressing Try again a few times spends. A create
the budget would refuse is refused before the invoice is made, and a refusal
for rate is named in the log once a minute."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine

from openreceive.server import Host, HttpRequest, OpenReceiveApp, Service
from openreceive.server.errors import ServiceError
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.swap.budget import FIXEDFLOAT_LIMITS, SwapProviderLimits, WeightBudgetError
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
    # The provider is FixedFloat's own host, the one the guard counts for. Each
    # Try again spends a create weight (50) before the provider answers: four
    # refusals fill the 200 soft cap, and the fifth press never reaches it.
    assert shop.provider.limits.profile == "fixedfloat"
    for _ in range(4):
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


# --- the guard is sized by the provider, and asked before the invoice is made

RATE_LIMITED_MESSAGE = "The swap provider is rate limited. Please try again shortly."
SWAP_REQUEST = {
    "reference": "order-busy",
    "amount": {"currency": "SAT", "value": "20000"},
    "pay_in_asset": "USDT_TRON",
}


class UncheckedProvider:
    """A provider double that keeps the guard the service attaches and reserves
    a create from it, like a provider written before the check existed. It
    states FixedFloat's limits, the only ones the guard counts for."""

    name = "fixedfloat"
    limits = FIXEDFLOAT_LIMITS

    def __init__(self) -> None:
        self.budget: Any = None
        self.creates = 0

    def supported_pay_in_assets(self) -> list[str]:
        return ["USDT_TRON"]

    def invoice_expiry_seconds(self, pay_in_asset: str | None = None) -> int:
        return 1800

    def attach_weight_budget(self, budget: Any) -> None:
        self.budget = budget

    def create_swap(self, **_: Any) -> dict[str, Any]:
        self.creates += 1
        self.budget.reserve("create")
        raise AssertionError("the spent weight budget must refuse this create")


class GuardedProvider(UncheckedProvider):
    """The same double, answering the "is a create available" question from
    the guard."""

    def assert_create_available(self) -> None:
        self.budget.assert_available("create")


class Busy:
    """The service with one provider double, and its log."""

    def __init__(self, caplog: pytest.LogCaptureFixture, provider: Any = None) -> None:
        self.now = 1_700_000_000
        self.caplog = caplog
        self.provider = provider or GuardedProvider()
        self.wallet = FakeWallet(clock=lambda: self.now)
        caplog.set_level(logging.WARNING, logger="openreceive-test")
        self.service = Service(
            self.wallet,
            price_provider=False,
            swap_providers=[self.provider],
            clock=lambda: self.now,
            logger=logging.getLogger("openreceive-test"),
        )

    def refused_create(self) -> ServiceError:
        with pytest.raises(ServiceError) as refused:
            self.service.create_swap(SWAP_REQUEST)
        return refused.value

    def rate_limit_lines(self) -> list[str]:
        return [
            record.getMessage()
            for record in self.caplog.records
            if record.getMessage().startswith("swap.provider.rate_limited:")
        ]


def test_a_create_the_guard_would_refuse_is_refused_before_an_invoice_is_made(
    caplog: pytest.LogCaptureFixture,
) -> None:
    busy = Busy(caplog)
    for _ in range(4):
        busy.provider.budget.reserve("create")
    for _ in range(2):
        error = busy.refused_create()
        assert error.status == 503 and error.code == "INTERNAL" and error.retryable is True
        assert str(error) == RATE_LIMITED_MESSAGE
    assert busy.wallet.list_invoices() == []
    assert busy.provider.creates == 0
    # Two refusals, one log line: status polls must not bury the log.
    lines = busy.rate_limit_lines()
    assert len(lines) == 1
    assert "this process reached the per-minute limit it keeps for FixedFloat" in lines[0]
    assert "provider=fixedfloat path=create reason=exhausted used=200 gate=200" in lines[0]


def test_another_providers_create_stand_off_is_refused_before_an_invoice_is_made(
    caplog: pytest.LogCaptureFixture,
) -> None:
    provider = GuardedProvider()
    provider.limits = None  # type: ignore[assignment]
    busy = Busy(caplog, provider)
    # A provider that states no limits is never counted locally...
    for _ in range(500):
        provider.budget.reserve("create")
    for _ in range(2_000):
        provider.budget.reserve("order")
    # ...but its 429 on a create stops new swaps, before an invoice is made.
    provider.budget.mark_rate_limited(path="create", retry_after_seconds=20)
    error = busy.refused_create()
    assert error.status == 503 and str(error) == RATE_LIMITED_MESSAGE
    assert busy.wallet.list_invoices() == []
    assert provider.creates == 0
    lines = busy.rate_limit_lines()
    assert len(lines) == 1
    assert f"reason=backoff backoff_until={busy.now + 20}" in lines[0]
    assert "used=" not in lines[0]
    # Status and refund calls for swaps that already exist keep going.
    provider.budget.reserve("order")
    provider.budget.reserve("emergency")


def test_a_rate_refusal_is_logged_once_a_minute_per_cause(
    caplog: pytest.LogCaptureFixture,
) -> None:
    busy = Busy(caplog)
    start = busy.now
    # A provider 429 on a status call: every call stands off for ten minutes.
    busy.provider.budget.mark_rate_limited(path="order", retry_after_seconds=600)
    busy.refused_create()
    busy.now = start + 59
    busy.refused_create()
    assert len(busy.rate_limit_lines()) == 1
    busy.now = start + 60
    busy.refused_create()
    lines = busy.rate_limit_lines()
    assert len(lines) == 2
    assert "standing off after the provider's 429" in lines[0]
    assert f"reason=backoff used=0 gate=200 backoff_until={start + 600}" in lines[0]
    assert busy.wallet.list_invoices() == []


def test_a_provider_429_is_logged_once_a_minute_with_the_providers_own_words(
    shop: Shop, caplog: pytest.LogCaptureFixture
) -> None:
    shop.answers["create"] = {
        "status": 429,
        "headers": {"Retry-After": "600"},
        "body": json.dumps({"code": 429, "msg": "Too many requests"}),
    }
    status, body = shop.create_swap()
    assert status == 503 and body["message"] == RATE_LIMITED_MESSAGE
    assert "Too many requests" not in json.dumps(body)
    invoices = len(shop.service.nwc_client.list_invoices())
    assert invoices == 1 and shop.calls.count("create") == 1
    # The guard obeys the provider's ten minutes: the next presses are refused
    # before an invoice is made, and before the provider is asked.
    for _ in range(2):
        status, body = shop.create_swap()
        assert status == 503 and body["message"] == RATE_LIMITED_MESSAGE
    assert len(shop.service.nwc_client.list_invoices()) == invoices
    assert shop.calls.count("create") == 1
    lines = [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("swap.provider.rate_limited:")
    ]
    # One line for the provider's 429, one for the stand-off that followed it.
    assert len(lines) == 2
    assert "The swap provider answered 429 (rate limited)" in lines[0]
    assert "Too many requests" in lines[0]
    assert "standing off after the provider's 429" in lines[1]
    assert f"backoff_until={shop.now + 600}" in lines[1]


def test_the_service_builds_the_guard_from_the_limits_the_provider_exposes(
    caplog: pytest.LogCaptureFixture,
) -> None:
    lightning_swap = FixedFloatProvider(
        key="synthetic-key", secret="synthetic-secret", base_url="https://lightning-swap.com"
    )
    Busy(caplog, lightning_swap)
    assert lightning_swap._weight_budget is not None
    assert lightning_swap._weight_budget.limits.profile == "provider-only"
    fixedfloat = FixedFloatProvider(key="synthetic-key", secret="synthetic-secret")
    Busy(caplog, fixedfloat)
    assert fixedfloat._weight_budget is not None
    assert fixedfloat._weight_budget.limits.profile == "fixedfloat"
    # A provider that exposes no limits, or something that is not limits, is
    # never counted locally.
    for limits in (None, {"local_budget": {"soft_cap": 1}}):
        double = GuardedProvider()
        double.limits = limits  # type: ignore[assignment]
        Busy(caplog, double)
        assert isinstance(double.budget.limits, SwapProviderLimits)
        assert double.budget.limits.profile == "provider-only"


def test_a_provider_without_the_check_is_not_asked(caplog: pytest.LogCaptureFixture) -> None:
    provider = UncheckedProvider()
    busy = Busy(caplog, provider)
    for _ in range(4):
        provider.budget.reserve("create")
    error = busy.refused_create()
    assert error.status == 503 and str(error) == RATE_LIMITED_MESSAGE
    # The create itself still reserves, so the answer is the same one; only the
    # invoice was made first.
    assert provider.creates == 1
    assert len(busy.wallet.list_invoices()) == 1
