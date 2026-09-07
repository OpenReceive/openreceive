"""The production receive client over the in-repo transport, against the fake
relay from tests/nwc: request building, reply normalization, wallet errors
and TransportError mapping — the seam the live smoke exercises for real."""

from __future__ import annotations

import threading
from typing import Any

import pytest

from openreceive.nwc.errors import WalletError
from openreceive.nwc.receive_client import NwcReceiveClient
from openreceive.nwc.transport import NwcTransport
from openreceive.server.service import Service
from tests.nwc.fake_relay import CLIENT_SECRET, WALLET_SECRET, FakeRelay, FakeWallet

HASH = "ab" * 32


def wallet_handler(method: str, params: dict[str, Any]) -> dict[str, Any]:
    if method == "make_invoice":
        return {
            "result_type": method,
            "result": {
                "invoice": "lnbcfake",
                "payment_hash": HASH,
                "amount": params["amount"],
                "created_at": 1000,
                "expires_at": 1000 + params.get("expiry", 600),
            },
        }
    if method == "list_transactions":
        return {
            "result_type": method,
            "result": {
                "transactions": [
                    {
                        "type": "incoming",
                        "payment_hash": HASH,
                        "amount": 1000,
                        "state": "settled",
                        "settled_at": 1200,
                    }
                ]
            },
        }
    return {"result_type": method, "error": {"code": "NOT_IMPLEMENTED", "message": "nope"}}


def client_for(relay: FakeRelay, wallet: FakeWallet) -> NwcReceiveClient:
    # The URI form never appears in tests (scan:secrets); build the transport
    # from the parts and hand it to the client, as a host with a custom relay
    # session would.
    transport = NwcTransport(wallet.keys.pubkey, [relay.url], CLIENT_SECRET, deadline_seconds=5)
    client = NwcReceiveClient.__new__(NwcReceiveClient)
    client._transport = transport
    client._deadline_seconds = 5
    client.redacted_connection_uri = "[test]"
    return client


def test_receive_client_normalizes_requests_replies_and_errors() -> None:
    wallet = FakeWallet(WALLET_SECRET, handler=wallet_handler)
    with FakeRelay(wallet) as relay:
        client = client_for(relay, wallet)
        info = client.preflight()
        assert "make_invoice" in info["methods"]
        minted = client.make_invoice({"amount_msats": 1000, "expiry": 600, "description": "x"})
        assert minted == {
            "invoice": "lnbcfake",
            "payment_hash": HASH,
            "amount_msats": 1000,
            "created_at": 1000,
            "expires_at": 1600,
        }
        assert wallet.requests[-1] == (
            "make_invoice",
            {"amount": 1000, "expiry": 600, "description": "x"},
        )
        rows = client.list_transactions({"type": "incoming", "limit": 20, "offset": 0})[
            "transactions"
        ]
        assert rows[0]["transaction_state"] == "settled" and rows[0]["settled_at"] == 1200
        with pytest.raises(WalletError) as raised:
            client._request("pay_invoice", {})
        assert raised.value.code == "NOT_IMPLEMENTED"
        # The service's preflight accepts the receive-only info and mints through it.
        service = Service(client, price_provider=False, swap_providers=[], clock=lambda: 1000)
        checkout = service.create_checkout({"reference": "ord-1", "amount": {"sats": 1}})
        assert checkout["payment_hash"] == HASH and checkout["bolt11"] == "lnbcfake"
        assert (
            service.reconcile_payments({"attempts": [{"payment_hash": HASH, "created_at": 1000}]})[
                0
            ]["status"]
            == "settled"
        )
        client.close()


def test_transport_errors_become_canonical_wallet_errors() -> None:
    wallet = FakeWallet(WALLET_SECRET, handler=wallet_handler)
    with FakeRelay(wallet, silent=True) as relay:
        client = client_for(relay, wallet)
        client._transport = NwcTransport(
            wallet.keys.pubkey, [relay.url], CLIENT_SECRET, deadline_seconds=0.5, encryption="nip04"
        )
        with pytest.raises(WalletError) as raised:
            client.list_transactions({"type": "incoming"})
        assert raised.value.code == "TIMEOUT"


def test_notifications_reach_the_handler_until_stopped() -> None:
    wallet = FakeWallet(WALLET_SECRET, handler=wallet_handler)
    with FakeRelay(wallet) as relay:
        client = client_for(relay, wallet)
        received: list[dict[str, Any]] = []
        stop = threading.Event()
        thread = threading.Thread(
            target=client.subscribe_notifications, args=(received.append,), kwargs={"stop": stop}
        )
        thread.start()
        try:
            for _ in range(200):
                if relay.subscription_count(kind=23197):
                    break
                threading.Event().wait(0.01)
            relay.push_notification(
                "payment_received",
                {"payment_hash": HASH, "state": "settled", "settled_at": 5},
                client.transport.pubkey,
            )
            for _ in range(200):
                if received:
                    break
                threading.Event().wait(0.01)
        finally:
            stop.set()
            thread.join(timeout=5)
        assert received and received[0]["notification_type"] == "payment_received"
        assert received[0]["notification"]["payment_hash"] == HASH
        client.close()
