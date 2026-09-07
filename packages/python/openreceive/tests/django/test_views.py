"""The thin views: the mount, the host's CSRF middleware answered with the
shared error contract, the Django request reaching `authorize`, and one whole
mint → settle → fulfill round trip through the ORM repository."""

from __future__ import annotations

import json
from typing import Any

import pytest
from django.http import HttpRequest
from django.middleware.csrf import get_token
from django.test import Client, RequestFactory

from openreceive.server import OpenReceiveApp
from tests.django import host as test_host

pytestmark = pytest.mark.django_db(transaction=True)

PREFIX = "/openreceive"


def csrf_client() -> tuple[Client, str]:
    """A client that enforces CSRF, holding a token the way a rendered page
    would: `<meta name="csrf-token" content="{{ csrf_token }}">` plus the
    `csrftoken` cookie the middleware set."""
    client = Client(enforce_csrf_checks=True)
    token = get_token(RequestFactory().get("/"))
    client.cookies["csrftoken"] = token
    return client, token


def post(
    client: Client,
    route: str,
    body: dict[str, Any] | None,
    *,
    token: str | None = None,
    **headers: str,
) -> tuple[int, dict[str, Any]]:
    extra: dict[str, str] = {}
    if token is not None:
        extra["HTTP_X_CSRFTOKEN"] = token
    for name, value in headers.items():
        extra["HTTP_" + name.upper().replace("-", "_")] = value
    response = client.post(
        f"{PREFIX}{route}",
        data=json.dumps(body or {}),
        content_type="application/json",
        **extra,
    )
    return response.status_code, json.loads(response.content)


def test_rates_mount_and_wrong_method(app: OpenReceiveApp) -> None:
    client = Client()
    response = client.get(f"{PREFIX}/rates?currencies=USD")
    assert response.status_code == 200
    assert response["Content-Type"] == "application/json"
    assert json.loads(response.content) == {"bitcoin": {"usd": "50000.00"}}
    assert response["x-request-id"].startswith("req_")
    # A known path with the wrong method is the engine's 405, not Django's.
    response = client.get(f"{PREFIX}/checkouts")
    assert response.status_code == 405
    assert json.loads(response.content)["code"] == "INVALID_REQUEST"


def test_csrf_is_the_hosts_middleware_answered_in_the_error_contract(app: OpenReceiveApp) -> None:
    client, token = csrf_client()
    status, body = post(client, "/checkouts/prepare", {"reference": test_host.REFERENCE})
    assert status == 403
    assert body["code"] == "FORBIDDEN" and body["message"] == "Invalid or missing CSRF token."
    status, body = post(
        client,
        "/checkouts/prepare",
        {"reference": test_host.REFERENCE},
        token=token,
        x_test_user="alice",
    )
    assert status == 200, body
    assert body["amount_msats"] == 2_000_000 and body["description"] == "one button"
    # The engine's own gates run unchanged behind the CSRF check.
    status, body = post(
        client,
        "/checkouts/prepare",
        {"reference": test_host.REFERENCE},
        token=token,
        x_test_user="alice",
        sec_fetch_site="cross-site",
    )
    assert status == 403 and body["code"] == "FORBIDDEN"


def test_authorize_receives_the_django_request(app: OpenReceiveApp, state: test_host.State) -> None:
    client = Client()
    session = client.session
    session["user"] = "alice"
    session.save()
    status, body = post(client, "/checkouts", {"reference": test_host.REFERENCE})
    assert status == 201, body
    assert state.authorize_requests and isinstance(state.authorize_requests[-1], HttpRequest)
    assert state.authorize_requests[-1].session.get("user") == "alice"
    # Another visitor: the session says nobody, the header says nobody → 403.
    status, body = post(Client(), "/checkouts", {"reference": test_host.REFERENCE})
    assert status == 403 and body["code"] == "FORBIDDEN"
    status, body = post(client, "/checkouts", {"reference": "nope"})
    assert status == 404 and body["message"] == "Unknown reference."


def test_mint_settle_fulfill_once_through_the_orm(
    app: OpenReceiveApp, state: test_host.State
) -> None:
    client = Client()
    status, body = post(
        client, "/checkouts", {"reference": test_host.REFERENCE}, x_test_user="alice"
    )
    assert status == 201, body
    payment_hash = body["checkout"]["payment_hash"]
    assert body["checkout"]["bolt11"] == "lnbcopenreceive000001"
    # A repeated create re-serves the committed attempt.
    status, again = post(
        client, "/checkouts", {"reference": test_host.REFERENCE}, x_test_user="alice"
    )
    assert status == 201 and again["checkout"]["payment_hash"] == payment_hash
    assert len(state.wallet.list_invoices()) == 1

    status, body = post(
        client,
        "/payments/check",
        {"reference": test_host.REFERENCE, "payment_hash": payment_hash},
        x_test_user="alice",
    )
    assert status == 200 and body["status"] == "pending"

    state.wallet.settle_invoice(payment_hash, settled_at=state.now + 5)
    state.now += 3  # past the 2 s gate floor
    status, body = post(
        client,
        "/payments/check",
        {"reference": test_host.REFERENCE, "payment_hash": payment_hash},
        x_test_user="alice",
    )
    assert status == 200 and body["status"] == "settled", body
    assert [item.reference for item in state.paid] == [test_host.REFERENCE]
    assert state.paid[0].connection is None and state.in_atomic_block == [True]
    assert [item.reference for item in state.after] == [test_host.REFERENCE]
    # Replays never fulfill twice; a new checkout under a paid reference is refused.
    state.now += 3
    app.reconcile()
    assert len(state.paid) == 1
    status, body = post(
        client, "/checkouts", {"reference": test_host.REFERENCE}, x_test_user="alice"
    )
    assert status == 409 and body["message"] == "This reference is already paid."


def test_swap_data_never_reaches_the_wire(app: OpenReceiveApp, state: test_host.State) -> None:
    client = Client()
    status, body = post(
        client,
        "/swaps",
        {"reference": test_host.REFERENCE, "pay_in_asset": "USDT_TRON"},
        x_test_user="alice",
    )
    assert status == 201, body
    text = json.dumps(body)
    assert "provider_token" not in text and "swap_data" not in text
    assert body["swap"]["deposit_address"] == "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
    row = app.repository.find_by_payment_hash(body["swap"]["payment_hash"])  # type: ignore[attr-defined]
    assert row is not None and row.swap_data is not None and "swap_data" not in repr(row)


def test_oversized_body_is_refused_before_any_read(app: OpenReceiveApp) -> None:
    client = Client()
    response = client.post(
        f"{PREFIX}/checkouts",
        data=b"{}",
        content_type="application/json",
        HTTP_X_TEST_USER="alice",
        CONTENT_LENGTH=str(70_000),
    )
    assert response.status_code == 413
