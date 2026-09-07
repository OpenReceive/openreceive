"""The whole bridge over the fakes: visitor cookie → order → invoice through
the mounted engine → settle in the wallet → the reconcile pass flips the
order → the download unlocks. Plus the two boundaries: another visitor sees
a 404, and `/__testkit` is dead outside testkit mode."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from server.main import create_app


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    app = create_app(
        {"DEMO_WALLET": "testkit", "OPENRECEIVE_DEMO_DB": str(tmp_path), "LOG_LEVEL": "WARNING"}
    )
    with TestClient(app) as client:
        yield client


def test_order_pay_download(client: TestClient) -> None:
    bootstrap = client.get("/shop/bootstrap")
    assert bootstrap.status_code == 200
    shop = bootstrap.json()["shop"]
    assert shop["openreceive_prefix"] == "/openreceive" and len(shop["catalog"]) == 6
    assert shop["catalog"][0] == {
        "sku": "safety-orange",
        "name": "Safety Orange",
        "price_cents": 100,
        "image_url": "/images/openreceive-safety-orange-button.webp",
    }
    assert client.get(shop["catalog"][0]["image_url"]).status_code == 200

    empty = client.post("/shop/orders", json={"items": [{"sku": "nope", "quantity": 1}]})
    assert empty.status_code == 422 and empty.json() == {"error": "Your cart is empty."}

    order = client.post(
        "/shop/orders", json={"items": [{"sku": "safety-orange", "quantity": 1}]}
    ).json()
    reference = order["reference"]
    assert (
        order["total_amount"] == "1.00"
        and order["description"] == "OpenReceive button: Safety Orange"
    )
    assert order["items"][0]["download_path"] is None
    assert client.get(f"/shop/orders/{reference}/downloads/safety-orange").status_code == 403

    prepared = client.post("/openreceive/checkouts/prepare", json={"reference": reference})
    assert prepared.status_code == 200 and prepared.json()["amount_msats"] == 2_000_000
    created = client.post("/openreceive/checkouts", json={"reference": reference})
    assert created.status_code == 201, created.text
    payment_hash = created.json()["checkout"]["payment_hash"]
    assert payment_hash == "0" * 63 + "1"

    settled = client.post("/__testkit/settle", json={"payment_hash": payment_hash})
    assert settled.status_code == 200 and settled.json()["ok"] is True
    assert client.post("/__testkit/settle", json={"payment_hash": "f" * 64}).status_code == 404

    # The gate floor is 2 s for a young invoice; the next poll past it settles.
    deadline = time.monotonic() + 10
    status = "pending"
    while status != "settled" and time.monotonic() < deadline:
        time.sleep(0.5)
        status = client.post(
            "/openreceive/payments/check",
            json={"reference": reference, "payment_hash": payment_hash},
        ).json()["status"]
    assert status == "settled"

    paid = client.get(f"/shop/orders/{reference}").json()
    assert (
        paid["state"] == "paid"
        and paid["items"][0]["download_path"] == f"/shop/orders/{reference}/downloads/safety-orange"
    )
    download = client.get(paid["items"][0]["download_path"])
    assert download.status_code == 200 and download.headers["content-type"] == "image/webp"

    feed = client.get("/shop/recent_orders").json()
    assert feed["totals"] == {"paid_orders": 1, "buttons_sold": 1}
    assert feed["orders"][0]["buyer"] == shop["visitor"]["public_ref"]
    assert "reference" not in feed["orders"][0] and "download_path" not in str(feed)

    # Another browser: the order id is a claim, not proof.
    stranger = TestClient(client.app)
    assert stranger.get(f"/shop/orders/{reference}").status_code == 404
    assert stranger.post("/openreceive/checkouts", json={"reference": reference}).status_code == 403


def test_testkit_prefix_is_a_json_404_outside_testkit_mode(tmp_path: Path) -> None:
    app = create_app({"OPENRECEIVE_DEMO_DB": str(tmp_path), "DEMO_WALLET": "", "NWC_URI": ""})
    # Lazy: no lifespan, so the missing NWC_URI is not asserted here.
    client = TestClient(app)
    for path in ("/__testkit/state", "/__testkit/settle"):
        response = client.post(path, json={}) if path.endswith("settle") else client.get(path)
        assert response.status_code == 404 and response.json()["code"] == "NOT_FOUND"
    # Every engine route answers 503 rather than a traceback until the wallet is configured.
    prepared = client.post("/openreceive/checkouts/prepare", json={"reference": "x"})
    assert prepared.status_code == 503 and prepared.json()["code"] == "WALLET_UNAVAILABLE"
