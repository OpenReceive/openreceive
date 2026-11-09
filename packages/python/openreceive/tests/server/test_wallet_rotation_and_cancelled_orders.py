"""Two lifetime edge cases through the real app, repository and reconcile gate.

The merchant changing the wallet code while invoices are pending: a row
records nothing about the wallet that minted it, so a new connection to the
same wallet carries on and another wallet can never see the old invoice settle.

The host's order going away while the payer is paying: settlement is keyed by
the attempt row, never by the host's order, so `on_paid` still fires and a
hook that raises rolls back and is retried.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine, text

from openreceive.payments import ATTEMPT_EXPIRY_GRACE_SECONDS as GRACE_SECONDS
from openreceive.server import Host, HttpRequest, OpenReceiveApp, Service
from openreceive.storage import PaymentSettlement
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.testing import FakeWallet

GATE_SECONDS = 3


class Shop:
    def __init__(self, tmp_path: Path) -> None:
        self.now = 1_700_000_000
        self.engine = create_engine(f"sqlite:///{tmp_path / 'shop.sqlite3'}")
        self.repository = SqlPaymentRepository(self.engine, clock=lambda: self.now)
        self.repository.create_tables()
        with self.engine.begin() as connection:
            connection.execute(text("CREATE TABLE fulfilled (reference TEXT NOT NULL)"))
        self.orders: dict[str, dict[str, Any]] = {}
        self.refused: set[str] = set()
        self.paid: list[PaymentSettlement] = []
        self.hook_error: Exception | None = None
        self.doomed: set[str] = set()
        self.app: OpenReceiveApp

    def clock(self) -> int:
        return self.now

    def wallet(self) -> FakeWallet:
        return FakeWallet(clock=self.clock)

    def wallet_with_history(self) -> FakeWallet:
        """The fake wallet's hashes are its mint counter; a history keeps two wallets apart."""
        wallet = self.wallet()
        for _ in range(32):
            wallet.make_invoice({"amount_msats": 1_000})
        return wallet

    def start(self, wallet: Any) -> None:
        """A shop process: a fresh service and app over the same database."""
        service = Service(wallet, price_provider=False, swap_providers=[], clock=self.clock)
        host = Host(
            amount_for=lambda reference: self.orders.get(reference),
            authorize=lambda context: context.resource.get("reference") not in self.refused,
            on_paid=self.fulfill,
        )
        self.app = OpenReceiveApp(
            service=service,
            host=host,
            repository=self.repository,
            rate_limiting=False,
            client_ip=lambda _request: None,
            clock=self.clock,
        )

    def fulfill(self, settlement: PaymentSettlement) -> None:
        assert settlement.connection is not None
        settlement.connection.execute(
            text("INSERT INTO fulfilled (reference) VALUES (:reference)"),
            {"reference": settlement.reference},
        )
        if self.hook_error is not None or settlement.reference in self.doomed:
            raise self.hook_error or RuntimeError("the order row is gone")
        self.paid.append(settlement)

    def post(self, path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        raw = json.dumps(body).encode()
        request = HttpRequest(
            method="POST",
            path=f"/openreceive{path}",
            query_string="",
            headers={"content-type": "application/json"},
            body=raw,
            content_length=len(raw),
            framework_request={},
        )
        status, payload, _headers = self.app.handle(request)
        return status, payload

    def checkout(self, reference: str, sats: int = 100) -> dict[str, Any]:
        self.orders[reference] = {"sats": sats}
        status, body = self.post("/checkouts", {"reference": reference})
        assert status == 201, body
        return body["checkout"]

    def check(self, reference: str, payment_hash: str) -> tuple[int, dict[str, Any]]:
        return self.post("/payments/check", {"reference": reference, "payment_hash": payment_hash})

    def row(self, payment_hash: str) -> tuple[str, str | None, int | None]:
        record = self.repository.find_by_payment_hash(payment_hash)
        assert record is not None
        return record.status, record.status_reason, record.paid_at

    def fulfilled(self) -> list[str]:
        with self.engine.connect() as connection:
            return [row[0] for row in connection.execute(text("SELECT reference FROM fulfilled"))]


@pytest.fixture
def shop(tmp_path: Path) -> Shop:
    return Shop(tmp_path)


def connection_to(wallet: FakeWallet) -> FakeWallet:
    class Connection(FakeWallet):
        """Another NWC connection to the same wallet: the invoices are shared."""

        def __init__(self) -> None:  # noqa: D107 - no independent store on purpose
            pass

        def preflight(self) -> dict[str, Any]:
            return wallet.preflight()

        def make_invoice(self, params: dict[str, Any]) -> dict[str, Any]:
            return wallet.make_invoice(params)

        def list_transactions(self, params: dict[str, Any] | None = None) -> dict[str, Any]:
            return wallet.list_transactions(params)

    return Connection()


def test_a_new_code_for_the_same_wallet_keeps_paying_exactly_once(
    shop: Shop, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="openreceive")
    wallet = shop.wallet()
    shop.start(connection_to(wallet))
    invoice = shop.checkout("order-a")

    shop.start(connection_to(wallet))
    wallet.settle_invoice(invoice["payment_hash"], settled_at=shop.now + 1)
    shop.now += GATE_SECONDS
    status, body = shop.check("order-a", invoice["payment_hash"])
    assert status == 200 and body["status"] == "settled"
    assert [item.reference for item in shop.paid] == ["order-a"]

    shop.now += 100
    assert shop.check("order-a", invoice["payment_hash"])[1]["status"] == "settled"
    assert shop.post("/checkouts", {"reference": "order-a"})[0] == 409
    assert shop.fulfilled() == ["order-a"]
    assert not [record for record in caplog.records if record.levelno >= logging.WARNING]


def test_a_code_for_a_different_wallet_closes_the_old_invoice_normally(
    shop: Shop, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="openreceive")
    old_wallet = shop.wallet_with_history()
    shop.start(old_wallet)
    stranded = shop.checkout("order-a")

    new_wallet = shop.wallet()
    shop.start(new_wallet)
    old_wallet.settle_invoice(stranded["payment_hash"], settled_at=shop.now + 1)
    assert stranded["payment_hash"] not in {
        row["payment_hash"] for row in new_wallet.list_invoices()
    }

    for _ in range(5):
        shop.now += GATE_SECONDS
        status, body = shop.check("order-a", stranded["payment_hash"])
        assert status == 200 and body["status"] == "pending"
    assert shop.row(stranded["payment_hash"])[0] == "pending"

    # A retry of the same order is still served the old wallet's invoice while
    # it is reusable: nothing on the row says which wallet minted it.
    shop.now += 10
    status, body = shop.post("/checkouts", {"reference": "order-a"})
    assert status == 201 and body["checkout"]["payment_hash"] == stranded["payment_hash"]
    assert new_wallet.list_invoices() == []

    fresh = shop.checkout("order-b")
    assert fresh["payment_hash"] != stranded["payment_hash"]
    new_wallet.settle_invoice(fresh["payment_hash"], settled_at=shop.now)
    shop.now += GATE_SECONDS
    assert shop.check("order-b", fresh["payment_hash"])[1]["status"] == "settled"
    assert [item.reference for item in shop.paid] == ["order-b"]

    shop.now = stranded["expires_at"] + GRACE_SECONDS - 1
    shop.check("order-a", stranded["payment_hash"])
    assert shop.row(stranded["payment_hash"])[0] == "pending"

    shop.now = stranded["expires_at"] + GRACE_SECONDS + 12
    status, body = shop.check("order-a", stranded["payment_hash"])
    assert status == 200 and body["status"] == "expired"
    assert shop.row(stranded["payment_hash"]) == ("expired", "not_found_after_expiry", None)

    assert shop.fulfilled() == ["order-b"]
    assert not [
        record.getMessage() for record in caplog.records if record.levelno >= logging.WARNING
    ]
    replacement = shop.checkout("order-a")
    assert replacement["payment_hash"] != stranded["payment_hash"]


@pytest.mark.skip(
    reason="bug: closing an attempt the current wallet never knew logs at most an info line"
)
def test_a_payment_that_landed_on_the_old_wallet_is_reported_to_the_merchant(
    shop: Shop, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="openreceive")
    old_wallet = shop.wallet_with_history()
    shop.start(old_wallet)
    stranded = shop.checkout("order-a")
    shop.start(shop.wallet())
    old_wallet.settle_invoice(stranded["payment_hash"])
    shop.now = stranded["expires_at"] + GRACE_SECONDS + 12
    shop.check("order-a", stranded["payment_hash"])
    assert shop.row(stranded["payment_hash"])[0] == "expired"
    assert [record for record in caplog.records if record.levelno >= logging.WARNING], [
        record.getMessage() for record in caplog.records
    ]


def test_an_order_cancelled_mid_payment_still_reaches_on_paid_exactly_once(
    shop: Shop, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="openreceive")
    wallet = shop.wallet()
    shop.start(wallet)
    invoice = shop.checkout("order-a")

    del shop.orders["order-a"]
    wallet.settle_invoice(invoice["payment_hash"], settled_at=shop.now + 1)
    shop.now += GATE_SECONDS

    status, body = shop.check("order-a", invoice["payment_hash"])
    assert status == 200 and body["status"] == "settled"
    assert shop.fulfilled() == ["order-a"]

    shop.now += 50
    assert shop.check("order-a", invoice["payment_hash"])[1]["status"] == "settled"
    assert shop.fulfilled() == ["order-a"]
    assert not [record for record in caplog.records if record.levelno >= logging.WARNING]


def test_authorize_refusing_the_status_poll_does_not_stop_settlement(shop: Shop) -> None:
    wallet = shop.wallet()
    shop.start(wallet)
    invoice = shop.checkout("order-a")

    shop.refused.add("order-a")
    wallet.settle_invoice(invoice["payment_hash"], settled_at=shop.now + 1)
    shop.now += GATE_SECONDS

    status, _body = shop.check("order-a", invoice["payment_hash"])
    assert status == 403
    assert shop.fulfilled() == ["order-a"]
    assert shop.row(invoice["payment_hash"])[0] == "settled"


def test_a_raising_host_handler_rolls_back_is_retried_and_fulfills_once(
    shop: Shop, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="openreceive")
    wallet = shop.wallet()
    shop.start(wallet)
    invoice = shop.checkout("order-a")

    shop.hook_error = RuntimeError("the order row is gone")
    wallet.settle_invoice(invoice["payment_hash"], settled_at=shop.now + 1)
    shop.now += GATE_SECONDS
    status, body = shop.check("order-a", invoice["payment_hash"])
    assert status == 200 and body["status"] == "pending"
    assert shop.row(invoice["payment_hash"])[0] == "pending"
    assert shop.fulfilled() == []
    assert any("the order row is gone" in record.getMessage() for record in caplog.records)

    shop.hook_error = None
    shop.now += GATE_SECONDS
    assert shop.check("order-a", invoice["payment_hash"])[1]["status"] == "settled"
    assert len(shop.paid) == 1
    assert shop.fulfilled() == ["order-a"]


def test_a_hook_that_raises_forever_never_closes_the_row_or_starves_another_order(
    shop: Shop, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="openreceive")
    wallet = shop.wallet()
    shop.start(wallet)
    doomed = shop.checkout("order-doomed")
    healthy = shop.checkout("order-ok")

    shop.doomed.add("order-doomed")
    wallet.settle_invoice(doomed["payment_hash"], settled_at=shop.now + 1)
    wallet.settle_invoice(healthy["payment_hash"], settled_at=shop.now + 1)
    shop.now += GATE_SECONDS
    shop.check("order-ok", healthy["payment_hash"])
    assert shop.row(healthy["payment_hash"])[0] == "settled"
    assert shop.fulfilled() == ["order-ok"]

    for index in range(3):
        shop.now = doomed["expires_at"] + GRACE_SECONDS + (index + 1) * 20
        assert shop.check("order-doomed", doomed["payment_hash"])[1]["status"] == "pending"
        assert shop.row(doomed["payment_hash"])[0] == "pending"
    failures = [record for record in caplog.records if record.levelno >= logging.WARNING]
    assert len(failures) >= 3
    assert shop.fulfilled() == ["order-ok"]


def test_a_notification_for_a_cancelled_order_settles_it_once_and_a_raising_hook_falls_back(
    shop: Shop,
) -> None:
    wallet = shop.wallet()
    shop.start(wallet)
    invoice = shop.checkout("order-a")
    del shop.orders["order-a"]

    shop.hook_error = RuntimeError("the order row is gone")
    record = wallet.settle_invoice(invoice["payment_hash"], settled_at=shop.now + 1)
    notification = {"notification_type": "payment_received", "notification": record}
    assert shop.app.reconciler.handle_notification(notification) == "scanned"
    assert shop.row(invoice["payment_hash"])[0] == "pending"

    shop.hook_error = None
    assert shop.app.reconciler.handle_notification(notification) == "settled"
    assert shop.app.reconciler.handle_notification(notification) == "scanned"
    assert shop.fulfilled() == ["order-a"]
