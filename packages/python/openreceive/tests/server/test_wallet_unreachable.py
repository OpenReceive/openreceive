"""A wallet whose relay cannot be reached at start-up does not stop the
service: it starts, logs one line, answers the retryable 503
WALLET_UNAVAILABLE, and the first wallet call after the wait (1 s, doubling to
60 s) checks again. A wallet that is wrong still refuses, at start-up and on a
later check. The Node stack's createRetryingBoot behavior."""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine

from openreceive.nwc.errors import WalletError
from openreceive.nwc.receive_client import NwcReceiveClient
from openreceive.nwc.uri import NwcUriParseError
from openreceive.server import Host, HttpRequest, OpenReceiveApp, Service
from openreceive.server.errors import (
    SpendCapableWalletError,
    WalletFailureError,
    WalletPreflightError,
)
from openreceive.server.notifications import run_notifications_worker
from openreceive.server.service import (
    WALLET_NOT_READY_MESSAGE,
    WALLET_RETRY_MAX_SECONDS,
    wallet_unreachable,
)
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.testing import FakeWallet, StaticPriceProvider

REFERENCE = "order-42"
CONNECT_FAILURE = WalletError(
    "WALLET_UNAVAILABLE",
    "connect: could not connect to wss://relay.test.openreceive.local: "
    "[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol",
)
RECEIVE_ONLY_HINT = "Use a receive-only NWC connection"


class RelayWallet(FakeWallet):
    """The fake wallet behind a relay the test switches off and on. While it
    is down every call fails the way the transport fails a refused
    connection; `info` replaces what the wallet advertises once it is back."""

    def __init__(self) -> None:
        super().__init__(clock=lambda: 1_700_000_000)
        self.down = True
        self.info: dict[str, Any] | None = None
        self.preflights = 0
        self.mints = 0

    def preflight(self) -> dict[str, Any]:
        self.preflights += 1
        if self.down:
            raise CONNECT_FAILURE
        return self.info if self.info is not None else super().preflight()

    def make_invoice(self, params: dict[str, Any]) -> dict[str, Any]:
        self.mints += 1
        if self.down:
            raise CONNECT_FAILURE
        return super().make_invoice(params)


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def service_over(wallet: Any, clock: Clock, **options: Any) -> Service:
    return Service(
        wallet,
        price_provider=StaticPriceProvider(),
        swap_providers=[],
        clock=lambda: 1_700_000_000,
        monotonic=clock,
        env={},
        **options,
    )


class Shop:
    def __init__(self, tmp_path: Path, wallet: Any, clock: Clock) -> None:
        self.service = service_over(wallet, clock)
        engine = create_engine(f"sqlite:///{tmp_path / 'shop.sqlite3'}")
        repository = SqlPaymentRepository(engine, clock=lambda: 1_700_000_000)
        repository.create_tables()
        self.app = OpenReceiveApp(
            service=self.service,
            host=Host(
                amount_for=lambda reference: {"sats": 1000} if reference == REFERENCE else None,
                authorize=lambda context: True,
                on_paid=lambda settlement: None,
            ),
            repository=repository,
        )

    def checkout(self) -> tuple[int, dict[str, Any]]:
        raw = json.dumps({"reference": REFERENCE}).encode()
        status, body, _headers = self.app.handle(
            HttpRequest(
                method="POST",
                path="/openreceive/checkouts",
                headers={"content-type": "application/json"},
                body=raw,
                content_length=len(raw),
            )
        )
        return status, body


def wallet_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [record.getMessage() for record in caplog.records if "wallet." in record.getMessage()]


def test_an_unreachable_wallet_at_start_up_starts_and_logs_what_happens_next(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger="openreceive")
    service = service_over(RelayWallet(), Clock())
    assert service.wallet_pending is not None
    assert wallet_lines(caplog) == [
        "wallet.unreachable: OpenReceive could not reach the wallet's relay at start-up "
        "(WalletError: connect: could not connect to wss://relay.test.openreceive.local: "
        "[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol). "
        "The first checkout after 1 s tries again."
    ]
    assert RECEIVE_ONLY_HINT not in caplog.text
    assert caplog.records[0].levelno == logging.ERROR


def test_checkouts_answer_the_retryable_503_then_are_served_once_the_relay_answers(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="openreceive")
    wallet, clock = RelayWallet(), Clock()
    shop = Shop(tmp_path, wallet, clock)
    assert wallet.preflights == 1

    status, body = shop.checkout()
    assert status == 503
    assert body["code"] == "WALLET_UNAVAILABLE" and body["retryable"] is True
    assert body["message"] == WALLET_NOT_READY_MESSAGE
    # No retry before the wait is over, and nothing reached the wallet.
    clock.now += 0.9
    assert shop.checkout()[0] == 503
    assert (wallet.preflights, wallet.mints) == (1, 0)

    # The wait is over, the relay still refuses: one check, then twice the wait.
    clock.now += 0.1
    assert shop.checkout()[0] == 503
    assert (wallet.preflights, wallet.mints) == (2, 0)
    assert wallet_lines(caplog)[-1].startswith(
        "wallet.unreachable: OpenReceive still cannot reach the wallet's relay (WalletError: "
    )
    assert wallet_lines(caplog)[-1].endswith("The first checkout after 2 s tries again.")
    clock.now += 1.9
    assert shop.checkout()[0] == 503
    assert wallet.preflights == 2

    # The relay is back: the first checkout after the wait checks and is served.
    wallet.down = False
    clock.now += 0.1
    status, body = shop.checkout()
    assert status == 201, body
    assert body["checkout"]["bolt11"].startswith("lnbcopenreceive")
    assert shop.service.wallet_pending is None
    assert wallet_lines(caplog)[-1] == (
        "wallet.reachable: OpenReceive reached the wallet's relay and the wallet check passed."
    )
    # Checked once: later wallet calls go straight to the wallet.
    shop.service.create_checkout({"reference": "order-43", "amount": {"sats": 1000}})
    assert (wallet.preflights, wallet.mints) == (3, 2)


def test_the_wait_doubles_to_sixty_seconds() -> None:
    wallet, clock = RelayWallet(), Clock()
    service = service_over(wallet, clock)
    waits = []
    for _ in range(9):
        before = wallet.preflights
        while wallet.preflights == before:
            clock.now += 0.5
            with pytest.raises(WalletFailureError):
                service.ensure_wallet()
        waits.append(service._wallet_retry_seconds)
    assert waits == [2, 4, 8, 16, 32, 60, 60, 60, 60]
    assert WALLET_RETRY_MAX_SECONDS == 60


def test_every_wallet_call_waits_for_the_check(tmp_path: Path) -> None:
    wallet, clock = RelayWallet(), Clock()
    service = service_over(wallet, clock)
    attempt = {"payment_hash": "a" * 64, "created_at": 1_700_000_000}
    with pytest.raises(WalletFailureError) as failure:
        service.reconcile_payments({"attempts": [attempt]})
    assert failure.value.status == 503 and failure.value.code == "WALLET_UNAVAILABLE"
    with pytest.raises(WalletFailureError):
        service.create_checkout({"reference": REFERENCE, "amount": {"sats": 1000}})
    assert (wallet.preflights, wallet.mints) == (1, 0)


@pytest.mark.parametrize(
    ("info", "refusal"),
    [
        (
            {
                "methods": ["make_invoice", "list_transactions", "pay_invoice"],
                "encryption": ["nip04"],
            },
            "NOT receive-only",
        ),
        ({"methods": ["make_invoice"], "encryption": ["nip04"]}, RECEIVE_ONLY_HINT),
    ],
)
def test_a_later_check_refuses_a_wallet_that_is_wrong(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, info: dict[str, Any], refusal: str
) -> None:
    caplog.set_level(logging.INFO, logger="openreceive")
    wallet, clock = RelayWallet(), Clock()
    shop = Shop(tmp_path, wallet, clock)
    wallet.down, wallet.info = False, info
    clock.now += 1
    status, body = shop.checkout()
    assert status == 503 and body["code"] == "WALLET_UNAVAILABLE"
    assert wallet.mints == 0
    assert shop.service.wallet_pending is not None
    line = wallet_lines(caplog)[-1]
    assert line.startswith(
        "wallet.refused: OpenReceive reached the wallet's relay, but the wallet check failed"
    )
    assert refusal in line and line.endswith("The first checkout after 2 s checks again.")
    # The refusal holds until a check passes.
    assert shop.checkout()[0] == 503
    assert wallet.mints == 0


def test_a_wallet_that_is_wrong_still_refuses_at_start_up() -> None:
    clock = Clock()
    spend = RelayWallet()
    spend.down = False
    spend.info = {"methods": ["make_invoice", "list_transactions", "pay_invoice"]}
    with pytest.raises(SpendCapableWalletError):
        service_over(spend, clock)
    receive = RelayWallet()
    receive.down = False
    receive.info = {"methods": ["make_invoice"], "encryption": ["nip04"]}
    with pytest.raises(WalletPreflightError, match=RECEIVE_ONLY_HINT):
        service_over(receive, clock)


def test_an_answer_that_is_wrong_is_not_deferred() -> None:
    class NoInfoEvent(RelayWallet):
        def preflight(self) -> dict[str, Any]:
            raise WalletError("OTHER", "protocol: wss://relay.test holds no info event")

    with pytest.raises(WalletPreflightError, match="holds no info event"):
        service_over(NoInfoEvent(), Clock())


def test_a_malformed_code_still_fails_at_start_up() -> None:
    with pytest.raises(NwcUriParseError):
        NwcReceiveClient("nostr+walletconnect://not-a-pubkey?relay=wss://relay.test")

    class Malformed(RelayWallet):
        def preflight(self) -> dict[str, Any]:
            raise NwcUriParseError("INVALID_SECRET", "secret must be 64 hex characters")

    with pytest.raises(NwcUriParseError):
        service_over(Malformed(), Clock())


@pytest.mark.parametrize(
    "error",
    [
        CONNECT_FAILURE,
        WalletError("TIMEOUT", "deadline: wss://relay.test did not answer before the deadline"),
        ConnectionRefusedError("[Errno 111] Connection refused"),
        TimeoutError("timed out"),
    ],
)
def test_what_counts_as_unreachable(error: BaseException) -> None:
    assert wallet_unreachable(error)


@pytest.mark.parametrize(
    "error",
    [
        WalletError("UNSUPPORTED_ENCRYPTION", "decrypt: bad MAC"),
        WalletError("OTHER", "protocol: no info event"),
        WalletError("RESTRICTED", "not allowed"),
        ValueError("bad shape"),
    ],
)
def test_what_does_not_count_as_unreachable(error: BaseException) -> None:
    assert not wallet_unreachable(error)


def test_concurrent_calls_share_one_check() -> None:
    gate = threading.Event()

    class SlowRelay(RelayWallet):
        def preflight(self) -> dict[str, Any]:
            if self.preflights >= 1:
                gate.wait(5)
            return super().preflight()

    wallet, clock = SlowRelay(), Clock()
    service = service_over(wallet, clock)
    wallet.down = False
    clock.now += 1
    errors: list[BaseException] = []

    def call() -> None:
        try:
            service.ensure_wallet()
        except BaseException as error:  # pragma: no cover - asserted below
            errors.append(error)

    threads = [threading.Thread(target=call) for _ in range(4)]
    for thread in threads:
        thread.start()
    gate.set()
    for thread in threads:
        thread.join(5)
    assert errors == []
    assert wallet.preflights == 2


def test_the_notifications_worker_subscribes_only_once_the_check_passes(tmp_path: Path) -> None:
    class Listener(RelayWallet):
        def __init__(self) -> None:
            super().__init__()
            self.subscribed = threading.Event()

        def subscribe_notifications(self, handler: Any, *, stop: Any = None) -> None:
            self.subscribed.set()
            super().subscribe_notifications(handler, stop=stop)

    wallet, clock = Listener(), Clock()
    shop = Shop(tmp_path, wallet, clock)
    stop = threading.Event()
    worker = threading.Thread(
        target=run_notifications_worker,
        args=(shop.app.reconciler,),
        kwargs={"interval_seconds": 60, "stop": stop},
    )
    worker.start()
    try:
        assert not wallet.subscribed.wait(0.3)
        wallet.down = False
        clock.now += 1
        assert wallet.subscribed.wait(5)
    finally:
        stop.set()
        worker.join(5)
