"""Provider logger hooks receive metadata while real transport retains credentials."""

import json

import pytest

from openreceive.swap.fixedfloat import FixedFloatProvider


@pytest.mark.parametrize("throwing_sink", [False, True])
def test_provider_create_status_refund_diagnostics(throwing_sink):
    events, requests = [], []
    token = "synthetic-private-token"
    raw = {
        "id": "fixture-order",
        "token": token,
        "status": "NEW",
        "from": {"address": "fixture-address", "amount": "1.05"},
        "time": {"expiration": 1600},
        "nested": {"preimage": "synthetic-private-preimage"},
    }

    def transport(**request):
        requests.append(request)
        return {"status": 200, "body": json.dumps({"code": 0, "data": raw, "msg": token})}

    def sink(event):
        events.append(event)
        if throwing_sink:
            raise RuntimeError("logger unavailable")

    provider = FixedFloatProvider(key="synthetic-key", secret="synthetic-secret", http=transport)
    provider.attach_api_request_logger(sink)
    provider.attach_api_response_logger(sink)
    provider._resolve_currencies = lambda: {
        "pay_in": {"USDT_TRON": {"code": "fixture-usdt"}},
        "lightning": {"code": "fixture-ln"},
    }
    provider._fetch_order_fee = lambda *_: None
    order = provider.create_swap(
        pay_in_asset="USDT_TRON", bolt11="fixture-private-invoice", invoice_amount_msats=1000
    )
    assert order["provider_token"] == token
    refreshed = provider.get_status(order)
    provider.request_refund(refreshed, "fixture-refund-address")
    assert [request["url"].rsplit("/", 1)[-1] for request in requests] == [
        "create",
        "order",
        "emergency",
    ]
    for request in requests[1:]:
        assert json.loads(request["body"])["token"] == token
    assert json.loads(requests[0]["body"])["toAddress"] == "fixture-private-invoice"
    assert len(events) == 6
    assert all(event["provider"] == "fixedfloat" for event in events)
    assert [event["status"] for event in events if "status" in event] == [200, 200, 200]
    text = json.dumps(events)
    for secret in (
        token,
        "synthetic-key",
        "synthetic-secret",
        "synthetic-private-preimage",
        "fixture-private-invoice",
    ):
        assert secret not in text
    assert "has_token" in text
