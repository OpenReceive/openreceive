"""The whole hop-by-hop path over the test client, with the engine's fakes:

  POST /shop/orders                   mint ONE order row, priced from shop_products
  POST /openreceive/checkouts         -> authorize -> amount_for -> an invoice
  POST /__testkit/settle              the wallet reports payment
  POST /openreceive/payments/check    -> settlement -> on_paid -> claim_paid
  GET  /shop/orders/<id>              re-read the row; downloads have unlocked
"""

from __future__ import annotations

from tests.conftest import Browser

from buttonshop import openreceive_service
from buttonshop.shop.models import ShopOrder
from openreceive.django.models import OpenReceivePayment


def test_authorize_reads_the_signed_cookie_off_the_django_request(browser: Browser) -> None:
    order = browser.create_order()
    response = browser.post("/openreceive/checkouts", {"reference": order["reference"]})
    assert response.status_code == 201, response.content
    # A different browser: no cookie → 403, and nothing was minted for it.
    stranger = Browser()
    denied = stranger.post("/openreceive/checkouts", {"reference": order["reference"]})
    assert denied.status_code == 403 and denied.json()["code"] == "FORBIDDEN"
    # The real owner's uuid, unsigned, is still nobody.
    stranger.client.cookies["shop_user_id"] = str(ShopOrder.objects.get().shop_user_id)
    assert stranger.post("/openreceive/checkouts", {"reference": order["reference"]}).status_code == 403
    assert OpenReceivePayment.objects.count() == 1


def test_csrf_is_enforced_on_the_engine_routes_too(browser: Browser) -> None:
    order = browser.create_order()
    denied = browser.post("/openreceive/checkouts/prepare", {"reference": order["reference"]}, csrf=False)
    assert denied.status_code == 403
    assert denied.json()["message"] == "Invalid or missing CSRF token."


def test_checkout_mints_settles_and_unlocks_the_download(browser: Browser) -> None:
    order = browser.create_order("safety-orange", 2)
    reference = order["reference"]

    prepared = browser.post("/openreceive/checkouts/prepare", {"reference": reference}).json()
    assert prepared["amount_msats"] == 4_000_000  # $2.00 at the static $50,000
    assert prepared["description"] == "OpenReceive buttons: Safety Orange ×2"

    created = browser.post("/openreceive/checkouts", {"reference": reference})
    assert created.status_code == 201, created.content
    checkout = created.json()["checkout"]
    payment_hash = checkout["payment_hash"]
    assert checkout["bolt11"] == "lnbcopenreceive000001"
    assert payment_hash == "0" * 63 + "1"

    # Nothing is paid yet: the order row says so. (No payments/check poll here:
    # a poll claims the durable scan gate, and a second scan inside its 2 s
    # floor would be answered from the row — the engine's own tests drive the
    # clock; this one lets the single post-settlement poll be the first scan.)
    assert browser.get(f"/shop/orders/{reference}").json()["state"] == "awaiting_payment"

    # The wallet reports payment. The control surface never touches shop tables.
    settled = browser.post("/__testkit/settle", {"payment_hash": payment_hash}, csrf=False)
    assert settled.status_code == 200 and settled.json()["ok"] is True
    assert ShopOrder.objects.get(pk=reference).state == "awaiting_payment"

    # The notification the fake emitted has no worker to hear it here; the
    # payer's own poll is the settlement trigger, through the gated reconcile.
    checked = browser.post(
        "/openreceive/payments/check", {"reference": reference, "payment_hash": payment_hash}
    ).json()
    assert checked["status"] == "settled", checked
    row = ShopOrder.objects.get(pk=reference)
    assert row.state == "paid" and row.payment_hash == payment_hash and row.paid_at is not None
    receipt = browser.get(f"/shop/orders/{reference}").json()
    assert receipt["state"] == "paid"
    assert receipt["items"][0]["download_path"] == f"/shop/orders/{reference}/downloads/safety-orange"
    assert browser.get(receipt["items"][0]["download_path"]).status_code == 200

    # A new checkout under a paid reference is refused, never fulfilled again.
    again = browser.post("/openreceive/checkouts", {"reference": reference})
    assert again.status_code == 409 and again.json()["message"] == "This reference is already paid."
    assert OpenReceivePayment.objects.get(payment_hash=payment_hash).status == "settled"


def test_a_swap_attempt_keeps_its_credentials_server_side(browser: Browser) -> None:
    order = browser.create_order()
    response = browser.post(
        "/openreceive/swaps", {"reference": order["reference"], "pay_in_asset": "USDT_TRON"}
    )
    assert response.status_code == 201, response.content
    body = response.content.decode()
    assert "provider_token" not in body and "swap_data" not in body
    swap = response.json()["swap"]
    assert swap["deposit_address"] == "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
    assert swap["provider_order_id"] == "testkit-swap-1"
    assert openreceive_service.fakes.provider.counters()["create_calls"] == 1
