"""The /__testkit control surface: alive under DEMO_WALLET=testkit, a hard
JSON 404 for every action otherwise (that is how a probe proves it is off)."""

from __future__ import annotations

import pytest
from tests.conftest import Browser

from buttonshop import openreceive_service


def test_every_action_is_404_when_testkit_is_off(monkeypatch: pytest.MonkeyPatch, browser: Browser) -> None:
    monkeypatch.setenv("DEMO_WALLET", "")
    for path in ("/__testkit/state", "/__testkit/settle", "/__testkit", "/__testkit/nope"):
        response = browser.post(path, {"payment_hash": "0" * 64}, csrf=False)
        assert response.status_code == 404, path
        assert response.json() == {"code": "NOT_FOUND", "message": "Not found.", "retryable": False}


def test_the_control_surface_drives_the_fakes(browser: Browser) -> None:
    wallet = openreceive_service.fakes.wallet
    minted = wallet.make_invoice({"amount_msats": 2_000_000, "expiry": 600})
    state = browser.get("/__testkit/state").json()
    assert [row["payment_hash"] for row in state["wallet"]["invoices"]] == [minted["payment_hash"]]
    assert state["swap"]["create_calls"] == 0

    missing = browser.post("/__testkit/settle", {}, csrf=False)
    assert missing.status_code == 400 and missing.json()["code"] == "INVALID_REQUEST"
    unknown = browser.post("/__testkit/settle", {"payment_hash": "f" * 64}, csrf=False)
    assert unknown.status_code == 404
    settled = browser.post("/__testkit/settle", {"payment_hash": minted["payment_hash"]}, csrf=False)
    assert settled.status_code == 200 and settled.json()["transaction"]["transaction_state"] == "settled"

    other = wallet.make_invoice({"amount_msats": 1_000})
    expired = browser.post("/__testkit/expire", {"payment_hash": other["payment_hash"]}, csrf=False)
    assert expired.json()["transaction"]["transaction_state"] == "expired"

    bad = browser.post("/__testkit/swap-step", {"pay_in_asset": "USDT_TRON", "state": "nope"}, csrf=False)
    assert bad.status_code == 400 and "state must be one of" in bad.json()["message"]
    none = browser.post("/__testkit/swap-step", {"state": "confirming"}, csrf=False)
    assert none.status_code == 400
    armed = browser.post(
        "/__testkit/swap-step", {"pay_in_asset": "USDT_TRON", "state": "refund_required"}, csrf=False
    )
    assert armed.status_code == 200 and armed.json() == {"ok": True, "state": "refund_required"}
