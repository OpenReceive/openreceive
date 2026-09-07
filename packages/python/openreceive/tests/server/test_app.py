"""The storage-aware app over SQLite with the fakes: mint → poll → settle →
fulfill exactly once, notifications, closure after expiry+grace, the
built-in rate limiter, and the swap flow through the fake provider."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine

from openreceive.payments import ATTEMPT_EXPIRY_GRACE_SECONDS
from openreceive.server import Host, HttpRequest, OpenReceiveApp, Service
from openreceive.server.notifications import run_notifications_worker
from openreceive.storage import PaymentSettlement
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.testing import FakeSwapProvider, FakeWallet, StaticPriceProvider

REFERENCE = "order-42"


class Harness:
    def __init__(
        self, tmp_path: Path, *, rate_limiting: bool | dict[str, Any] = False, swaps: bool = True
    ) -> None:
        self.now = 1_700_000_000
        self.wallet = FakeWallet(clock=lambda: self.now)
        self.provider = FakeSwapProvider(clock=lambda: self.now)
        self.paid: list[PaymentSettlement] = []
        self.after: list[PaymentSettlement] = []
        engine = create_engine(f"sqlite:///{tmp_path / 'app.sqlite3'}")
        self.repository = SqlPaymentRepository(engine, clock=lambda: self.now)
        self.repository.create_tables()
        self.service = Service(
            self.wallet,
            price_provider=StaticPriceProvider(),
            swap_providers=[self.provider] if swaps else [],
            clock=lambda: self.now,
        )
        self.host = Host(
            amount_for=lambda reference: (
                {"currency": "USD", "value": "1.00", "description": "one button"}
                if reference == REFERENCE
                else None
            ),
            authorize=lambda context: (
                context.request is not None and context.request.get("user") == "alice"
            ),
            on_paid=self.paid.append,
            after_paid=self.after.append,
        )
        self.app = OpenReceiveApp(
            service=self.service,
            host=self.host,
            repository=self.repository,
            rate_limiting=rate_limiting,
            client_ip=lambda request: request.get("ip") if isinstance(request, dict) else None,
            clock=lambda: self.now,
        )

    def call(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        user: str = "alice",
        ip: str = "203.0.113.9",
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        raw = b"" if body is None else json.dumps(body).encode()
        route, _, query = path.partition("?")
        request = HttpRequest(
            method=method,
            path=f"/openreceive{route}",
            query_string=query,
            headers={"content-type": "application/json"},
            body=raw,
            content_length=len(raw),
            framework_request={"user": user, "ip": ip},
        )
        status, payload, headers = self.app.handle(request)
        return status, payload, headers


@pytest.fixture
def harness(tmp_path: Path) -> Harness:
    return Harness(tmp_path)


def test_mint_poll_settle_fulfills_exactly_once(harness: Harness) -> None:
    status, body, headers = harness.call("POST", "/checkouts/prepare", {"reference": REFERENCE})
    assert (
        status == 200 and body["amount_msats"] == 2_000_000 and body["description"] == "one button"
    )
    assert body["fiat_quote"]["btc_fiat_price"] == "50000.00"
    assert len(body["payment_methods"]) == 7 and all(
        option["available"] for option in body["payment_methods"]
    )

    status, body, _ = harness.call("POST", "/checkouts", {"reference": REFERENCE})
    assert status == 201, body
    checkout = body["checkout"]
    payment_hash = checkout["payment_hash"]
    assert checkout["bolt11"] == "lnbcopenreceive000001" and body["description"] == "one button"
    assert harness.repository.list_for_reference(REFERENCE)[0].status == "pending"
    # A repeated create re-serves the committed attempt instead of minting again.
    status, again, _ = harness.call("POST", "/checkouts", {"reference": REFERENCE})
    assert status == 201 and again["checkout"]["payment_hash"] == payment_hash
    assert len(harness.wallet.list_invoices()) == 1

    status, body, _ = harness.call(
        "POST", "/payments/check", {"reference": REFERENCE, "payment_hash": payment_hash}
    )
    assert status == 200 and body["status"] == "pending" and "details" not in body

    harness.wallet.settle_invoice(payment_hash, settled_at=harness.now + 5)
    harness.now += 3  # past the 2 s gate floor for a young invoice
    status, body, _ = harness.call(
        "POST", "/payments/check", {"reference": REFERENCE, "payment_hash": payment_hash}
    )
    assert status == 200 and body["status"] == "settled" and body["paid_at"] == harness.now + 2
    assert body["details"]["paid_at_source"] == "settled_at"
    assert (
        "preimage" not in body["details"]["transaction"]
        and "invoice" not in body["details"]["transaction"]
    )
    assert [item.reference for item in harness.paid] == [REFERENCE]
    assert harness.paid[0].connection is not None
    assert [item.reference for item in harness.after] == [REFERENCE]

    # Replays: another poll and another pass never fulfill twice.
    harness.now += 3
    status, body, _ = harness.call(
        "POST", "/payments/check", {"reference": REFERENCE, "payment_hash": payment_hash}
    )
    assert status == 200 and body["status"] == "settled"
    harness.app.reconcile()
    assert len(harness.paid) == 1
    # A new checkout under a settled reference is refused, never fulfilled again.
    status, body, _ = harness.call("POST", "/checkouts", {"reference": REFERENCE})
    assert status == 409 and body["message"] == "This reference is already paid."


def test_authorization_and_unknown_reference(harness: Harness) -> None:
    status, body, _ = harness.call("POST", "/checkouts", {"reference": REFERENCE}, user="mallory")
    assert status == 403 and body["code"] == "FORBIDDEN"
    status, body, _ = harness.call("POST", "/checkouts", {"reference": "nope"})
    assert status == 404 and body["message"] == "Unknown reference."
    status, body, _ = harness.call(
        "POST", "/payments/check", {"reference": REFERENCE, "payment_hash": "a" * 64}
    )
    assert status == 404 and body["message"] == "Payment attempt not found for this reference."
    status, body, _ = harness.call("GET", "/rates?currencies=USD")
    assert status == 200 and body == {"bitcoin": {"usd": "50000.00"}}


def test_notification_settles_directly_without_a_wallet_scan(harness: Harness) -> None:
    status, body, _ = harness.call("POST", "/checkouts", {"reference": REFERENCE})
    payment_hash = body["checkout"]["payment_hash"]
    stop = threading.Event()
    worker = threading.Thread(
        target=run_notifications_worker,
        args=(harness.app.reconciler,),
        kwargs={"interval_seconds": 3600, "stop": stop},
    )
    worker.start()
    try:
        for _ in range(200):
            if harness.wallet._handlers:  # the worker subscribed
                break
            threading.Event().wait(0.01)
        harness.wallet.settle_invoice(payment_hash, notify=True)
        for _ in range(200):
            if harness.paid:
                break
            threading.Event().wait(0.01)
    finally:
        stop.set()
        worker.join(timeout=10)
    assert [item.payment_hash for item in harness.paid] == [payment_hash]
    assert harness.paid[0].details["paid_at_source"] == "settled_at"
    # A notification without finality only wakes a scan; an unknown hash too.
    assert (
        harness.app.reconciler.handle_notification(
            {"notification_type": "payment_received", "notification": {"payment_hash": "b" * 64}}
        )
        == "scanned"
    )
    assert (
        harness.app.reconciler.handle_notification(
            {"notification_type": "other", "notification": {}}
        )
        == "ignored"
    )


def test_closure_waits_for_a_scan_past_expiry_plus_grace(harness: Harness) -> None:
    status, body, _ = harness.call("POST", "/checkouts", {"reference": REFERENCE})
    payment_hash = body["checkout"]["payment_hash"]
    expires_at = body["checkout"]["expires_at"]
    # A wallet that still lists the invoice as pending at expiry+grace-1: keep waiting.
    harness.now = expires_at + ATTEMPT_EXPIRY_GRACE_SECONDS - 1
    harness.app.reconcile()
    assert harness.repository.find_by_payment_hash(payment_hash).status == "pending"  # type: ignore[union-attr]
    # At expiry+grace the wallet's own unpaid listing still says pending → attention.
    harness.now = expires_at + ATTEMPT_EXPIRY_GRACE_SECONDS
    harness.app.reconcile()
    row = harness.repository.find_by_payment_hash(payment_hash)
    assert (
        row is not None
        and row.status == "attention"
        and row.status_reason == "unsettled_after_expiry"
    )
    # And a wallet-reported expiry closes another attempt immediately.
    other_reference = REFERENCE
    harness.host.amount_for = lambda reference: {"sats": 1000}
    status, body, _ = harness.call("POST", "/checkouts", {"reference": other_reference})
    assert status == 201
    second = body["checkout"]["payment_hash"]
    harness.wallet.expire_invoice(second)
    harness.now += 3
    harness.app.reconcile()
    row = harness.repository.find_by_payment_hash(second)
    assert (
        row is not None
        and row.status == "expired"
        and row.status_reason == "wallet_reported_expired"
    )
    # The row path serves attention as pending to the payer.
    status, body, _ = harness.call(
        "POST", "/payments/check", {"reference": REFERENCE, "payment_hash": payment_hash}
    )
    assert status == 200 and body["status"] == "pending"


def test_built_in_rate_limiting_meters_minting_only(tmp_path: Path) -> None:
    harness = Harness(tmp_path, rate_limiting={"limit_per_hour": 1})
    status, body, _ = harness.call("POST", "/checkouts", {"reference": REFERENCE})
    assert status == 201
    # The same reference re-fetches its committed attempt: no mint, no throttle.
    status, _, _ = harness.call("POST", "/checkouts", {"reference": REFERENCE})
    assert status == 201
    harness.host.amount_for = lambda reference: {"sats": 1000}
    status, body, headers = harness.call("POST", "/checkouts", {"reference": "order-43"})
    assert status == 429 and body["retryable"] is True and headers["retry-after"] == "60"
    assert body["message"] == "Too many payment attempts. Please try again later."
    # Another payer (IP) is unaffected.
    status, _, _ = harness.call("POST", "/checkouts", {"reference": "order-44"}, ip="198.51.100.7")
    assert status == 201


def test_swap_flow_through_the_fake_provider(harness: Harness) -> None:
    status, body, _ = harness.call(
        "POST", "/swaps/quote", {"reference": REFERENCE, "pay_in_asset": "USDT_TRON"}
    )
    assert status == 200 and body["pay_amount"] == "1.05" and body["provider"] == "fixedfloat"
    status, body, _ = harness.call(
        "POST", "/swaps", {"reference": REFERENCE, "pay_in_asset": "USDT_TRON"}
    )
    assert status == 201, body
    swap = body["swap"]
    assert "swap_data" not in swap and "provider_token" not in json.dumps(body)
    assert swap["deposit_address"] == "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
    assert (
        swap["checkout"]["expires_at"] - swap["checkout"]["created_at"] == 1800
    )  # the provider's floor
    payment_hash = swap["payment_hash"]
    row = harness.repository.find_by_payment_hash(payment_hash)
    assert row is not None and row.swap_data is not None and row.expires_at == harness.now + 900
    # A Lightning attempt may live alongside the swap attempt (another rail).
    status, body, _ = harness.call("POST", "/checkouts", {"reference": REFERENCE})
    assert status == 201 and body["checkout"]["payment_hash"] != payment_hash
    # Status, refund refused before refund_required, then accepted.
    status, body, _ = harness.call(
        "POST", "/swaps/status", {"reference": REFERENCE, "payment_hash": payment_hash}
    )
    assert status == 200 and body["provider_state"] == "awaiting_deposit"
    status, body, _ = harness.call(
        "POST",
        "/swaps/refunds",
        {
            "reference": REFERENCE,
            "payment_hash": payment_hash,
            "refund_address": "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
        },
    )
    assert status == 409
    harness.provider.force_refund_required({"provider_order_id": swap["provider_order_id"]})
    status, body, _ = harness.call(
        "POST",
        "/swaps/refunds",
        {
            "reference": REFERENCE,
            "payment_hash": payment_hash,
            "refund_address": "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBg",
        },
    )
    assert status == 400 and "not a valid USDT_TRON address" in body["message"]
    status, body, _ = harness.call(
        "POST",
        "/swaps/refunds",
        {
            "reference": REFERENCE,
            "payment_hash": payment_hash,
            "refund_address": "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
        },
    )
    assert status == 200 and body["provider_state"] == "refund_pending"


def test_placeholder_hooks_warn(tmp_path: Path) -> None:
    from openreceive.server import ALLOW_ALL_AUTHORIZE, LOGGING_ON_PAID

    host = Host(
        amount_for=lambda reference: {"sats": 1},
        authorize=ALLOW_ALL_AUTHORIZE,
        on_paid=LOGGING_ON_PAID,
    )
    assert len(host.placeholder_warnings()) == 2
    engine = create_engine(f"sqlite:///{tmp_path / 'p.sqlite3'}")
    repository = SqlPaymentRepository(engine)
    repository.create_tables()
    with pytest.warns(UserWarning, match="placeholder"):
        OpenReceiveApp(
            service=Service(FakeWallet(), price_provider=False, swap_providers=[]),
            host=host,
            repository=repository,
        )
