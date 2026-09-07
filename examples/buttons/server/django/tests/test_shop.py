"""The shop's own routes: the bootstrap, the trust boundary on order creation,
the private/public payload split, and the download gate."""

from __future__ import annotations

from tests.conftest import Browser

from buttonshop.shop import catalog
from buttonshop.shop.models import ShopOrder, ShopProduct


def test_bootstrap_sets_the_visitor_cookie_and_the_csrf_cookie(browser: Browser) -> None:
    response = browser.get("/shop/bootstrap")
    assert response.status_code == 200
    shop = response.json()["shop"]
    assert shop["openreceive_prefix"] == "/openreceive" and shop["currency"] == "USD"
    assert [entry["sku"] for entry in shop["catalog"]] == [e["sku"] for e in catalog.entries()]
    assert shop["catalog"][0]["image_url"] == "/images/openreceive-safety-orange-button.webp"
    assert "shop_user_id" in response.cookies and "csrftoken" in response.cookies
    assert response["Cache-Control"] == "no-store"
    # The visitor's PRIVATE id never appears in the payload; the public handle does.
    assert set(shop["visitor"]) == {"public_ref"}


def test_order_creation_is_the_trust_boundary(browser: Browser) -> None:
    # Unknown SKU dropped, quantity clamped, duplicate lines merged, price from the row.
    response = browser.post(
        "/shop/orders",
        {
            "items": [
                {"sku": "safety-orange", "quantity": 7},
                {"sku": "safety-orange", "quantity": 7},
                {"sku": "nope", "quantity": 1},
                {"sku": "classic-black", "quantity": 1, "price_cents": 1},
            ]
        },
    )
    assert response.status_code == 201, response.content
    order = response.json()
    assert order["total_cents"] == 10 * 100 + 500 and order["total_amount"] == "15.00"
    assert [(item["sku"], item["quantity"]) for item in order["items"]] == [
        ("safety-orange", 10),
        ("classic-black", 1),
    ]
    assert order["state"] == "awaiting_payment" and order["items"][0]["download_path"] is None
    assert order["description"] == "OpenReceive buttons: Safety Orange ×10, Classic Black"
    # An empty cart is a 422 with a sentence a payer can act on.
    empty = browser.post("/shop/orders", {"items": [{"sku": "nope", "quantity": 1}]})
    assert empty.status_code == 422 and empty.json() == {"error": "Your cart is empty."}
    # CSRF is ON for the shop's own POST.
    assert browser.post("/shop/orders", {"items": []}, csrf=False).status_code == 403


def test_another_visitor_sees_404_never_403(browser: Browser) -> None:
    order = browser.create_order()
    assert browser.get(f"/shop/orders/{order['reference']}").status_code == 200
    stranger = Browser()
    assert stranger.get(f"/shop/orders/{order['reference']}").status_code == 404
    # A raw uuid pasted as the cookie fails the signature and reads as nobody.
    stranger.client.cookies["shop_user_id"] = str(ShopOrder.objects.get().shop_user_id)
    assert stranger.get(f"/shop/orders/{order['reference']}").status_code == 404


def test_download_is_gated_on_the_paid_row(browser: Browser) -> None:
    order = browser.create_order()
    path = f"/shop/orders/{order['reference']}/downloads/safety-orange"
    assert browser.get(path).status_code == 403
    from django.utils import timezone

    assert ShopOrder.claim_paid(reference=order["reference"], paid_at=timezone.now(), payment_hash="a" * 64)
    # Idempotent: the second claim updates zero rows.
    assert not ShopOrder.claim_paid(reference=order["reference"], paid_at=timezone.now(), payment_hash="b" * 64)
    response = browser.get(path)
    assert response.status_code == 200 and response["Content-Type"] == "image/webp"
    assert "attachment" in response["Content-Disposition"]
    paid = browser.get(f"/shop/orders/{order['reference']}").json()
    assert paid["state"] == "paid" and paid["items"][0]["download_path"] == path


def test_the_public_feed_is_paid_only_and_carries_no_reference(browser: Browser) -> None:
    unpaid = browser.create_order("midnight-navy")
    paid = browser.create_order("classic-black", 2)
    from django.utils import timezone

    ShopOrder.claim_paid(reference=paid["reference"], paid_at=timezone.now(), payment_hash="c" * 64)
    response = Browser().get("/shop/recent_orders")
    assert response.status_code == 200 and response["Cache-Control"] == "public, max-age=10"
    feed = response.json()
    assert feed["totals"] == {"paid_orders": 1, "buttons_sold": 2}
    assert len(feed["orders"]) == 1
    text = response.content.decode()
    assert paid["reference"] not in text and unpaid["reference"] not in text
    assert "download_path" not in text
    row = feed["orders"][0]
    assert row["items"] == [
        {
            "sku": "classic-black",
            "name": "Classic Black",
            "quantity": 2,
            "image_url": "/images/openreceive-classic-black-button.webp",
        }
    ]
    # Deactivating the product breaks neither the receipt nor the feed row.
    ShopProduct.objects.filter(sku="classic-black").update(active=False)
    assert browser.get(f"/shop/orders/{paid['reference']}").json()["items"][0]["name"] == "Classic Black"
    assert Browser().get("/shop/recent_orders").json()["orders"][0]["items"][0]["sku"] == "classic-black"


def test_artwork_route_serves_catalog_images_only(browser: Browser) -> None:
    assert browser.get("/images/openreceive-safety-orange-button.webp").status_code == 200
    assert browser.get("/images/openreceive-nope-button.webp").status_code == 404
    assert browser.get("/images/../shop-catalog.json").status_code == 404
