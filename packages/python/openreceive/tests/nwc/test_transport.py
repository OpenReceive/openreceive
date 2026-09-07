"""NwcTransport against the in-process fake relay and wallet."""

from __future__ import annotations

import socket
import threading
import time
from typing import Any

import pytest
from fake_relay import CLIENT_SECRET, STRANGER_SECRET, WALLET_SECRET, FakeRelay, FakeWallet

from openreceive.nwc.transport import NwcTransport, TransportError
from openreceive.nwc.transport.nip01 import KeyPair


def _transport(relay: FakeRelay, **kwargs: Any) -> NwcTransport:
    assert relay.wallet is not None
    return NwcTransport(
        relay.wallet.keys.pubkey, [relay.url], CLIENT_SECRET, deadline_seconds=5.0, **kwargs
    )


def _closed_port_url() -> str:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return f"ws://127.0.0.1:{port}"


def _wait(predicate: Any, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "condition not met in time"
        time.sleep(0.01)


# -- info + encryption negotiation ----------------------------------------------


def test_info_summarizes_the_wallet_event_and_caches(relay: FakeRelay) -> None:
    transport = _transport(relay)
    info = transport.info()
    assert info["methods"] == ["get_info", "make_invoice", "list_transactions"]
    assert info["notifications"] == ["payment_received"]
    assert info["encryption"] == ["nip44_v2", "nip04"]
    assert info["raw_content"] == "get_info make_invoice list_transactions"
    assert transport.encryption() == "nip44_v2"
    assert transport.info() is info


def test_missing_encryption_tag_means_nip04() -> None:
    with FakeRelay(FakeWallet(WALLET_SECRET, encryption=None, notifications=())) as relay:
        transport = _transport(relay)
        assert transport.info()["encryption"] == []
        assert transport.info()["notifications"] == []
        assert transport.encryption() == "nip04"


def test_unknown_encryption_only_is_a_protocol_error() -> None:
    with FakeRelay(FakeWallet(WALLET_SECRET, encryption=("nip99",))) as relay:
        with pytest.raises(TransportError) as excinfo:
            _transport(relay).encryption()
        assert excinfo.value.kind == "protocol"


def test_info_missing_is_a_protocol_error() -> None:
    with FakeRelay(FakeWallet(WALLET_SECRET)) as relay:
        transport = NwcTransport(KeyPair(STRANGER_SECRET).pubkey, [relay.url], CLIENT_SECRET)
        with pytest.raises(TransportError) as excinfo:
            transport.info()
        assert excinfo.value.kind == "protocol"


# -- request/response -----------------------------------------------------------


def test_request_round_trip_nip44(relay: FakeRelay, wallet: FakeWallet) -> None:
    reply = _transport(relay).request("make_invoice", {"amount": 21000, "description": "x"})
    assert reply == {
        "result_type": "make_invoice",
        "result": {"echo": {"amount": 21000, "description": "x"}},
    }
    assert wallet.requests == [("make_invoice", {"amount": 21000, "description": "x"})]


def test_request_round_trip_nip04() -> None:
    wallet = FakeWallet(WALLET_SECRET, encryption=("nip04",))
    with FakeRelay(wallet) as relay:
        transport = _transport(relay)
        assert transport.encryption() == "nip04"
        reply = transport.request("list_transactions", {"limit": 20})
        assert reply == {"result_type": "list_transactions", "result": {"echo": {"limit": 20}}}


def test_encryption_override_skips_info(relay: FakeRelay, wallet: FakeWallet) -> None:
    transport = _transport(relay, encryption="nip04")
    assert transport.request("get_info", {}) == {"result_type": "get_info", "result": {"echo": {}}}
    assert transport._info is None


def test_error_reply_passes_through_verbatim() -> None:
    def refuse(method: str, params: dict[str, Any]) -> dict[str, Any]:
        return {"result_type": method, "error": {"code": "RESTRICTED", "message": "no"}}

    with FakeRelay(FakeWallet(WALLET_SECRET, handler=refuse)) as relay:
        reply = _transport(relay).request("make_invoice", {"amount": 1})
        assert reply == {
            "result_type": "make_invoice",
            "error": {"code": "RESTRICTED", "message": "no"},
        }


def test_silent_relay_raises_deadline_in_time() -> None:
    with FakeRelay(FakeWallet(WALLET_SECRET), silent=True) as relay:
        transport = _transport(relay, encryption="nip44_v2")
        started = time.monotonic()
        with pytest.raises(TransportError) as excinfo:
            transport.request("get_info", {}, deadline_seconds=0.8)
        elapsed = time.monotonic() - started
        assert excinfo.value.kind == "deadline"
        assert 0.7 <= elapsed < 0.8 + 0.6


def test_relays_are_tried_in_order(relay: FakeRelay, wallet: FakeWallet) -> None:
    transport = NwcTransport(
        wallet.keys.pubkey, [_closed_port_url(), relay.url], CLIENT_SECRET, deadline_seconds=5.0
    )
    assert transport.request("get_info", {})["result_type"] == "get_info"


def test_all_relays_down_raises_connect(wallet: FakeWallet) -> None:
    transport = NwcTransport(
        wallet.keys.pubkey,
        [_closed_port_url(), _closed_port_url()],
        CLIENT_SECRET,
        deadline_seconds=2.0,
        encryption="nip44_v2",
    )
    with pytest.raises(TransportError) as excinfo:
        transport.request("get_info", {})
    assert excinfo.value.kind == "connect"


# -- notifications ------------------------------------------------------------------


class _Subscriber:
    def __init__(self, transport: NwcTransport) -> None:
        self.transport = transport
        self.stop = threading.Event()
        self.received: list[dict[str, Any]] = []
        self.error: TransportError | None = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        try:
            self.transport.subscribe_notifications(self._handle, stop=self.stop)
        except TransportError as exc:
            self.error = exc

    def _handle(self, notification: dict[str, Any]) -> None:
        self.received.append(notification)
        if notification["notification"].get("explode"):
            raise RuntimeError("handler bug")

    def start(self, relay: FakeRelay, kind: int) -> _Subscriber:
        self.thread.start()
        _wait(lambda: relay.subscription_count(kind) == 1)
        return self


def test_notifications_decrypt_and_reject_other_authors(relay: FakeRelay) -> None:
    transport = _transport(relay)
    subscriber = _Subscriber(transport).start(relay, 23197)
    try:
        relay.push_notification(
            "payment_received",
            {"payment_hash": "ab" * 32},
            transport.pubkey,
            signer=KeyPair(STRANGER_SECRET),
        )
        relay.push_notification(
            "payment_received", {"payment_hash": "cd" * 32, "explode": True}, transport.pubkey
        )
        relay.push_notification("payment_received", {"payment_hash": "ef" * 32}, transport.pubkey)
        _wait(lambda: len(subscriber.received) == 2)
        assert [n["notification"]["payment_hash"] for n in subscriber.received] == [
            "cd" * 32,
            "ef" * 32,
        ]
        assert all(n["notification_type"] == "payment_received" for n in subscriber.received)
    finally:
        subscriber.stop.set()
        subscriber.thread.join(timeout=5)
    assert not subscriber.thread.is_alive()
    assert subscriber.error is None


def test_nip04_wallet_gets_kind_23196() -> None:
    wallet = FakeWallet(WALLET_SECRET, encryption=("nip04",))
    with FakeRelay(wallet) as relay:
        transport = _transport(relay)
        subscriber = _Subscriber(transport).start(relay, 23196)
        try:
            relay.push_notification(
                "payment_received", {"payment_hash": "01" * 32}, transport.pubkey, mode="nip04"
            )
            _wait(lambda: len(subscriber.received) == 1)
        finally:
            subscriber.stop.set()
            subscriber.thread.join(timeout=5)


def test_stop_event_ends_subscription(relay: FakeRelay) -> None:
    subscriber = _Subscriber(_transport(relay)).start(relay, 23197)
    started = time.monotonic()
    subscriber.stop.set()
    subscriber.thread.join(timeout=5)
    assert not subscriber.thread.is_alive()
    assert time.monotonic() - started < 2.0
    assert subscriber.error is None
    _wait(lambda: relay.subscription_count() == 0)


def test_socket_close_raises_closed(relay: FakeRelay) -> None:
    subscriber = _Subscriber(_transport(relay)).start(relay, 23197)
    relay.close_connections()
    subscriber.thread.join(timeout=5)
    assert not subscriber.thread.is_alive()
    assert subscriber.error is not None and subscriber.error.kind == "closed"


def test_transport_close_ends_subscription(relay: FakeRelay) -> None:
    transport = _transport(relay)
    subscriber = _Subscriber(transport).start(relay, 23197)
    transport.close()
    subscriber.thread.join(timeout=5)
    assert not subscriber.thread.is_alive()
    assert subscriber.error is not None and subscriber.error.kind == "closed"
