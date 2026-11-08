"""A shop with no swap provider configured takes Lightning payments end to end.

Every test boots the real service from an environment with no usable
LSC_URI_* value (`${LSC_URI_PRIMARY:-}` in Compose and a half-filled .env read
as blank, and blank means "not configured") and drives the real HTTP routes
with the fake wallet."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine

from openreceive.server import Host, HttpRequest, OpenReceiveApp, Service
from openreceive.server.doctor import doctor_report
from openreceive.storage import PaymentSettlement
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.testing import FakeWallet, StaticPriceProvider

# 1 sat is below every swap provider's minimum and 2 BTC above every maximum;
# neither limit may touch a Lightning invoice.
ORDERS = {"order-no-swap": 2_100, "order-tiny": 1, "order-huge": 200_000_000}
NO_SWAP_ENVIRONMENTS = {
    "no-LSC-variables": {},
    "LSC-empty": {"LSC_URI_PRIMARY": "", "LSC_URI_BACKUP": ""},
    "LSC-whitespace": {"LSC_URI_PRIMARY": "   ", "LSC_URI_BACKUP": "\t\n "},
}
NO_PROVIDER_MESSAGE = "No configured swap provider supports USDT_TRON."
NO_SWAP_DATA_MESSAGE = "The host order has no swap data."


class NoSwapShop:
    def __init__(self, tmp_path: Path, env: dict[str, str]) -> None:
        self.now = 1_700_000_000
        self.wallet = FakeWallet(clock=lambda: self.now)
        self.paid: list[PaymentSettlement] = []
        engine = create_engine(f"sqlite:///{tmp_path / 'no_swap.sqlite3'}")
        self.repository = SqlPaymentRepository(engine, clock=lambda: self.now)
        self.repository.create_tables()
        self.service = Service(
            self.wallet,
            price_provider=StaticPriceProvider(),
            env=env,
            clock=lambda: self.now,
            logger=logging.getLogger("openreceive-test"),
        )
        self.app = OpenReceiveApp(
            service=self.service,
            host=Host(
                amount_for=lambda reference: (
                    {"sats": ORDERS[reference]} if reference in ORDERS else None
                ),
                authorize=lambda context: True,
                on_paid=self.paid.append,
            ),
            repository=self.repository,
            clock=lambda: self.now,
        )

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

    def rates(self) -> tuple[int, dict[str, Any]]:
        status, payload, _ = self.app.handle(
            HttpRequest(
                method="GET",
                path="/openreceive/rates",
                query_string="currencies=USD",
                headers={},
                body=b"",
                content_length=0,
                remote_addr="203.0.113.9",
            )
        )
        return status, payload

    def minted(self) -> list[dict[str, Any]]:
        return self.wallet.list_invoices()


@pytest.fixture(params=sorted(NO_SWAP_ENVIRONMENTS))
def shop(
    request: pytest.FixtureRequest, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> NoSwapShop:
    caplog.set_level(logging.WARNING)
    return NoSwapShop(tmp_path, NO_SWAP_ENVIRONMENTS[request.param])


def provider_complaints(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        record.getMessage()
        for record in caplog.records
        if re.search("swap|lsc|provider", record.getMessage(), re.IGNORECASE)
    ]


def test_no_swap_provider_boot_is_quiet_and_builds_no_provider(
    shop: NoSwapShop, caplog: pytest.LogCaptureFixture
) -> None:
    assert shop.service.swap_providers == []
    assert provider_complaints(caplog) == []


@pytest.mark.parametrize("label", sorted(NO_SWAP_ENVIRONMENTS))
def test_no_swap_provider_doctor_reads_blank_codes_as_none_and_passes(label: str) -> None:
    nwc = f"nostr+walletconnect://{'a' * 64}?relay=wss%3A%2F%2Frelay.test&secret={'b' * 64}"
    report = doctor_report({"NWC_URI": nwc, **NO_SWAP_ENVIRONMENTS[label]}, offline=True)
    assert report.ok, report.text()
    assert "LSC_URI connections: 0" in report.text()


def test_no_swap_provider_prepare_mint_settle_and_paid_hook(
    shop: NoSwapShop, caplog: pytest.LogCaptureFixture
) -> None:
    status, prepared = shop.post("/checkouts/prepare", {"reference": "order-no-swap"})
    assert status == 200, prepared
    assert prepared["amount_msats"] == 2_100_000
    assert prepared["payment_methods"] == []
    assert shop.minted() == [], "prepare mints nothing"

    status, created = shop.post("/checkouts", {"reference": "order-no-swap"})
    assert status == 201, created
    checkout = created["checkout"]
    assert checkout["bolt11"].startswith("lnbc")
    assert re.fullmatch("[0-9a-f]{64}", checkout["payment_hash"])
    assert checkout["amount_msats"] == 2_100_000
    # The wire keeps the (empty) catalog, so a client's picker can stop loading.
    assert created["payment_methods"] == []
    assert len(shop.minted()) == 1
    assert shop.minted()[0]["amount_msats"] == 2_100_000

    check = {"reference": "order-no-swap", "payment_hash": checkout["payment_hash"]}
    status, pending = shop.post("/payments/check", check)
    assert status == 200, pending
    assert pending["status"] == "pending"
    assert pending["payment_methods"] == []

    shop.wallet.settle_invoice(checkout["payment_hash"], settled_at=shop.now + 1)
    shop.now += 12
    status, settled = shop.post("/payments/check", check)
    assert status == 200, settled
    assert settled["status"] == "settled"
    shop.now += 12
    assert shop.post("/payments/check", check)[1]["status"] == "settled"
    assert [settlement.reference for settlement in shop.paid] == ["order-no-swap"]
    assert provider_complaints(caplog) == []


@pytest.mark.parametrize("reference", ["order-tiny", "order-huge"])
def test_no_swap_provider_amounts_past_any_swap_limit_mint_exactly(
    shop: NoSwapShop, reference: str
) -> None:
    status, created = shop.post("/checkouts", {"reference": reference})
    assert status == 201, created
    assert created["checkout"]["amount_msats"] == ORDERS[reference] * 1000
    assert created["payment_methods"] == []


def test_no_swap_provider_swap_routes_refuse_cleanly_and_never_reach_the_wallet(
    shop: NoSwapShop, caplog: pytest.LogCaptureFixture
) -> None:
    for route in ("/swaps/quote", "/swaps"):
        status, body = shop.post(route, {"reference": "order-no-swap", "pay_in_asset": "USDT_TRON"})
        assert status == 503, (route, body)
        assert body["code"] == "INTERNAL"
        assert body["message"] == NO_PROVIDER_MESSAGE
    assert shop.minted() == [], "a refused swap mints no invoice"

    # Status and refund need an attempt to read, so mint one and ask about it.
    _, created = shop.post("/checkouts", {"reference": "order-no-swap"})
    payment_hash = created["checkout"]["payment_hash"]
    for route, extra in (
        ("/swaps/status", {}),
        ("/swaps/refunds", {"refund_address": "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"}),
    ):
        status, body = shop.post(
            route, {"reference": "order-no-swap", "payment_hash": payment_hash, **extra}
        )
        assert status == 404, (route, body)
        assert body["code"] == "NOT_FOUND"
        assert body["message"] == NO_SWAP_DATA_MESSAGE
    assert len(shop.minted()) == 1, "refused swap routes mint nothing"
    assert provider_complaints(caplog) == []


def test_no_swap_provider_rates_answer_so_a_checkout_cannot_hang(shop: NoSwapShop) -> None:
    status, body = shop.rates()
    assert status == 200, body
    assert body["bitcoin"]["usd"]


def test_a_paid_reference_answers_its_receipt_and_refuses_a_new_attempt(
    shop: NoSwapShop, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, created = shop.post("/checkouts", {"reference": "order-no-swap"})
    payment_hash = created["checkout"]["payment_hash"]
    shop.wallet.settle_invoice(payment_hash, settled_at=shop.now + 1)
    shop.now += 30
    # The host closes an order once it is paid: its price hook answers None.
    monkeypatch.delitem(ORDERS, "order-no-swap")

    status, prepared = shop.post("/checkouts/prepare", {"reference": "order-no-swap"})
    assert status == 200, prepared
    assert prepared["amount_msats"] == 2_100_000
    assert prepared["payment_methods"] == []
    assert prepared["paid"]["payment_hash"] == payment_hash
    assert prepared["paid"]["rail"] == "lightning"
    assert [settlement.reference for settlement in shop.paid] == ["order-no-swap"]

    for route, body in (
        ("/checkouts", {"reference": "order-no-swap"}),
        ("/swaps", {"reference": "order-no-swap", "pay_in_asset": "USDT_TRON"}),
    ):
        status, refused = shop.post(route, body)
        assert status == 409, refused
        assert refused["message"] == "This reference is already paid."
    assert len(shop.minted()) == 1, "nothing new was minted"
