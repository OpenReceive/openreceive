"""THE FIXTURES ARE THE CONTRACT. These fakes are a port of packages/js/testkit;
one Playwright suite drives every stack and asserts the same strings, so the
values are pinned here exactly as the Rails fixture test pins them
(examples/buttons/server/rails/test/lib/testkit_test.rb)."""

from __future__ import annotations

import threading

from openreceive.nwc.info import summarize
from openreceive.rates import StaticPriceProvider
from openreceive.swap import assets
from openreceive.testing import FakeSwapProvider, FakeWallet


def test_the_wallet_mints_the_js_testkit_invoice_and_payment_hash_fixtures() -> None:
    wallet = FakeWallet()
    first = wallet.make_invoice({"amount_msats": 2_000_000, "expiry": 600})
    assert first["payment_hash"] == "0" * 63 + "1"
    assert first["invoice"] == "lnbcopenreceive000001"
    assert first["amount_msats"] == 2_000_000
    # The requested expiry is honoured EXACTLY.
    assert first["expires_at"] - first["created_at"] == 600
    second = wallet.make_invoice({"amount_msats": 1_000})
    assert second["payment_hash"] == "0" * 63 + "2"


def test_a_pending_invoice_is_absent_from_history_and_settling_puts_it_there() -> None:
    wallet = FakeWallet()
    minted = wallet.make_invoice({"amount_msats": 2_000_000})
    assert wallet.list_transactions({})["transactions"] == []
    wallet.settle_invoice(minted["payment_hash"])
    rows = wallet.list_transactions({})["transactions"]
    assert len(rows) == 1
    assert rows[0]["payment_hash"] == minted["payment_hash"]
    assert rows[0]["transaction_state"] == "settled"
    assert rows[0]["settled_at"] > 0
    assert rows[0]["preimage"] == "1" * 64
    # The unpaid walk sees pending rows; paging and filters are honoured.
    pending = wallet.make_invoice({"amount_msats": 1_000})
    unpaid = wallet.list_transactions({"unpaid": True, "limit": 1, "offset": 0})["transactions"]
    assert unpaid[0]["payment_hash"] == pending["payment_hash"]  # newest first, hash desc on ties
    assert wallet.list_transactions({"type": "outgoing"})["transactions"] == []


def test_the_wallet_advertises_receive_methods_only() -> None:
    summary = summarize(FakeWallet().preflight())
    assert summary["receive_checkout_ready"] is True
    assert summary["spend_capability_advertised"] is False
    assert summary["encryption"] == "nip04"


def test_notifications_and_scripts() -> None:
    wallet = FakeWallet()
    minted = wallet.make_invoice({"amount_msats": 1_000})
    received: list[dict] = []
    wallet.subscribe_notifications(lambda n: received.append(n))
    wallet.subscribe_notifications(lambda n: (_ for _ in ()).throw(RuntimeError("boom")))
    wallet.settle_invoice({"invoice": minted["invoice"]}, notify=True)
    assert received[0]["notification_type"] == "payment_received"
    assert received[0]["notification"]["payment_hash"] == minted["payment_hash"]
    other = wallet.make_invoice({"amount_msats": 1_000})
    wallet.script_transaction_sequence(
        other["payment_hash"], ["expired", RuntimeError("relay hiccup")]
    )
    assert (
        wallet.list_transactions({"unpaid": True})["transactions"][0]["transaction_state"]
        == "expired"
    )
    try:
        wallet.list_transactions({"unpaid": True})
        raise AssertionError("scripted error was not raised")
    except RuntimeError:
        pass
    # Then falls back to the stored state.
    assert (
        wallet.list_transactions({"unpaid": True})["transactions"][0]["transaction_state"]
        == "expired"
    )
    # The blocking form returns when stop is set.
    stop = threading.Event()
    thread = threading.Thread(
        target=wallet.subscribe_notifications, args=(lambda n: None,), kwargs={"stop": stop}
    )
    thread.start()
    stop.set()
    thread.join(timeout=5)
    assert not thread.is_alive()


def test_the_swap_provider_mints_the_js_testkit_order_fixtures() -> None:
    provider = FakeSwapProvider()
    order = provider.create_swap(
        pay_in_asset="USDT_TRON", bolt11="lnbc1", invoice_amount_msats=2_000_000
    )
    assert order["provider"] == "fixedfloat"
    assert order["provider_order_id"] == "testkit-swap-1"
    assert order["provider_token"] == "testkit-token-1"
    assert order["deposit_address"] == "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
    assert order["deposit_amount"] == "1.05"
    assert order["state"] == "awaiting_deposit"
    assert provider.invoice_expiry_seconds() == 1800


def test_each_assets_deposit_address_pins_its_network_not_its_ticker() -> None:
    provider = FakeSwapProvider()
    tron = provider.create_swap(
        pay_in_asset="USDT_TRON", bolt11="a", invoice_amount_msats=2_000_000
    )
    solana = provider.create_swap(
        pay_in_asset="USDT_SOL", bolt11="b", invoice_amount_msats=2_000_000
    )
    ethereum = provider.create_swap(
        pay_in_asset="USDC_ETH", bolt11="c", invoice_amount_msats=2_000_000
    )
    assert tron["deposit_address"] == "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
    assert solana["deposit_address"] == "So11111111111111111111111111111111111111112"
    assert ethereum["deposit_address"] == "0x1111111111111111111111111111111111111111"


def test_a_script_advances_one_state_per_poll_and_then_holds() -> None:
    provider = FakeSwapProvider()
    order = provider.create_swap(
        pay_in_asset="USDT_TRON", bolt11="a", invoice_amount_msats=2_000_000
    )
    provider.script({"provider_order_id": order["provider_order_id"]}, ["confirming", "completed"])
    assert provider.get_status(order)["state"] == "confirming"
    completed = provider.get_status(order)
    assert completed["state"] == "completed"
    assert completed["deposit_tx_id"] == "testkit-deposit-tx"
    assert completed["payout_tx_id"] == "testkit-payout-tx"
    assert provider.get_status(order)["state"] == "completed"


def test_refund_required_lands_immediately_and_a_refund_moves_it_to_refund_pending() -> None:
    provider = FakeSwapProvider()
    order = provider.create_swap(
        pay_in_asset="USDT_TRON", bolt11="a", invoice_amount_msats=2_000_000
    )
    provider.force_refund_required({"provider_order_id": order["provider_order_id"]})
    assert provider.get_status(order)["state"] == "refund_required"
    provider.request_refund(order, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")
    assert provider.get_status(order)["state"] == "refund_pending"
    assert provider.counters()["refund_calls"] == [
        {
            "provider_order_id": order["provider_order_id"],
            "refund_address": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        }
    ]


def test_an_asset_scripted_before_any_attempt_arms_the_next_attempt_for_it() -> None:
    provider = FakeSwapProvider()
    provider.force_refund_required({"pay_in_asset": "SOL_SOL"})
    order = provider.create_swap(pay_in_asset="SOL_SOL", bolt11="a", invoice_amount_msats=2_000_000)
    assert provider.get_status(order)["state"] == "refund_required"
    provider.force_attention("USDT_ETH")
    attention = provider.create_swap(
        pay_in_asset="USDT_ETH", bolt11="b", invoice_amount_msats=2_000_000
    )
    status = provider.get_status(attention)
    assert status["state"] == "attention" and status["attention"] is True
    assert status["attention_reason"] == "provider_reported_emergency"


def test_the_catalog_covers_every_pay_in_asset_the_engine_knows() -> None:
    provider = FakeSwapProvider()
    assert sorted(row["pay_asset"] for row in provider.pay_in_asset_catalog()) == sorted(
        assets.PAY_IN_ASSETS
    )
    assert all(row["available"] for row in provider.pay_in_asset_catalog())
    provider.force_create_error()
    try:
        provider.create_swap(pay_in_asset="SOL_SOL", bolt11="a", invoice_amount_msats=1_000)
        raise AssertionError("forced create error was not raised")
    except RuntimeError:
        pass
    assert provider.counters()["create_calls"] == 0


def test_a_one_dollar_button_is_2000_sats_at_the_static_price() -> None:
    # The same constant the JS StaticPriceProvider uses: the one fixture shared
    # across languages and price code.
    assert StaticPriceProvider().btc_fiat_price("USD") == "50000.00"
