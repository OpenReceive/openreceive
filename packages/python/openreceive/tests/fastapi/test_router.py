"""The FastAPI binding through `TestClient`: routes under the mount prefix
with the engine's own HTTP semantics, `authorize` receiving the Starlette
request, a full mint → settle → fulfill loop over the fakes, the fail-closed
lifespan, and lazy mode."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine
from starlette.requests import Request

from openreceive.fastapi import OpenReceiveBinding, openreceive_lifespan, openreceive_router
from openreceive.server import ConfigurationError, Host
from openreceive.server.handler import MAX_BODY_BYTES
from openreceive.storage import PaymentSettlement
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.testing import FakeSwapProvider, FakeWallet, StaticPriceProvider

REFERENCE = "order-42"
PREFIX = "/openreceive"


class Shop:
    """A host with one order, owned by the visitor whose cookie says `alice`."""

    def __init__(self) -> None:
        self.paid: list[PaymentSettlement] = []
        self.seen_requests: list[Any] = []
        self.host = Host(
            amount_for=lambda reference: (
                {"currency": "USD", "value": "1.00", "description": "one button"}
                if reference == REFERENCE
                else None
            ),
            authorize=self.authorize,
            on_paid=self.paid.append,
        )

    def authorize(self, context: Any) -> bool:
        self.seen_requests.append(context.request)
        return bool(context.request.cookies.get("visitor") == "alice")


def build(
    tmp_path: Path,
    *,
    wallet: FakeWallet | None = None,
    lazy: bool = False,
    env: dict[str, str] | None = None,
    inject_wallet: bool = True,
    **router_options: Any,
) -> tuple[FastAPI, Shop, FakeWallet, Engine]:
    shop = Shop()
    wallet = wallet or FakeWallet()
    engine = create_engine(f"sqlite:///{tmp_path / 'shop.sqlite3'}")
    SqlPaymentRepository(engine).create_tables()
    router = openreceive_router(
        shop.host,
        engine=engine,
        nwc_client=wallet if inject_wallet else None,
        price_provider=StaticPriceProvider(),
        swap_providers=[FakeSwapProvider()],
        env=env,
        **router_options,
    )
    app = FastAPI(lifespan=openreceive_lifespan(shop.host, engine=engine, lazy=lazy))
    app.include_router(router, prefix=PREFIX)
    return app, shop, wallet, engine


def post(client: TestClient, path: str, body: dict[str, Any], **kwargs: Any) -> Any:
    return client.post(
        f"{PREFIX}{path}",
        content=json.dumps(body),
        headers={"content-type": "application/json", **kwargs.pop("headers", {})},
        **kwargs,
    )


def alice(client: TestClient) -> TestClient:
    """The visitor the shop's `authorize` accepts."""
    client.cookies.set("visitor", "alice")
    return client


def test_routes_mount_under_the_prefix_with_engine_semantics(tmp_path: Path) -> None:
    app, _shop, _wallet, _engine = build(tmp_path)
    with TestClient(app) as client:
        alice(client)
        rates = client.get(f"{PREFIX}/rates?currencies=USD")
        assert rates.status_code == 200 and rates.json() == {"bitcoin": {"usd": "50000.00"}}
        assert rates.headers["content-type"].startswith("application/json")

        # 404 vs 405 and the JSON error shape are the engine's, not FastAPI's.
        missing = client.get(f"{PREFIX}/nope")
        assert missing.status_code == 404 and missing.json()["code"] == "NOT_FOUND"
        wrong_method = client.get(f"{PREFIX}/checkouts")
        assert wrong_method.status_code == 405 and wrong_method.json()["code"] == "INVALID_REQUEST"

        # The content-type gate, the cross-site refusal and the body cap.
        not_json = client.post(
            f"{PREFIX}/checkouts", content="reference=x", headers={"content-type": "text/plain"}
        )
        assert not_json.status_code == 415
        cross_site = post(
            client, "/checkouts", {"reference": REFERENCE}, headers={"sec-fetch-site": "cross-site"}
        )
        assert cross_site.status_code == 403 and cross_site.json()["code"] == "FORBIDDEN"
        oversized = post(
            client, "/checkouts", {"reference": REFERENCE, "memo": "x" * (MAX_BODY_BYTES + 10)}
        )
        assert oversized.status_code == 413
        # Nothing above reached the wallet.
        assert _wallet.list_invoices() == []


def test_authorize_receives_the_starlette_request(tmp_path: Path) -> None:
    app, shop, _wallet, _engine = build(tmp_path)
    with TestClient(app) as client:
        denied = post(client, "/checkouts/prepare", {"reference": REFERENCE})
        assert denied.status_code == 403
        alice(client)
        allowed = post(client, "/checkouts/prepare", {"reference": REFERENCE})
        assert allowed.status_code == 200 and allowed.json()["amount_msats"] == 2_000_000
    assert len(shop.seen_requests) == 2
    assert all(isinstance(request, Request) for request in shop.seen_requests)
    assert shop.seen_requests[0].url.path == f"{PREFIX}/checkouts/prepare"


def test_mint_settle_fulfill_exactly_once(tmp_path: Path) -> None:
    app, shop, wallet, _engine = build(tmp_path)
    with TestClient(app) as client:
        alice(client)
        created = post(client, "/checkouts", {"reference": REFERENCE})
        assert created.status_code == 201, created.text
        checkout = created.json()["checkout"]
        assert checkout["bolt11"] == "lnbcopenreceive000001"
        payment_hash = checkout["payment_hash"]

        pending = post(
            client, "/payments/check", {"reference": REFERENCE, "payment_hash": payment_hash}
        )
        assert pending.status_code == 200 and pending.json()["status"] == "pending"

        wallet.settle_invoice(payment_hash)
        # The gate floor is 2 s for a young invoice; the app's clock is the real
        # one, so poll until the pass ran rather than sleeping a fixed time.
        import time

        deadline = time.monotonic() + 10
        status = "pending"
        while status != "settled" and time.monotonic() < deadline:
            time.sleep(0.5)
            polled = post(
                client, "/payments/check", {"reference": REFERENCE, "payment_hash": payment_hash}
            )
            status = polled.json()["status"]
        assert status == "settled"
        assert [item.reference for item in shop.paid] == [REFERENCE]
        assert shop.paid[0].connection is not None

        again = post(client, "/checkouts", {"reference": REFERENCE})
        assert again.status_code == 409
        assert len(shop.paid) == 1


def test_router_and_lifespan_share_one_binding(tmp_path: Path) -> None:
    app, _shop, _wallet, _engine = build(tmp_path)
    # FastAPI ≥ 0.141 wraps an included router (`original_router`); older
    # versions copy its routes flat — the CLI's walker accepts both.
    from openreceive.cli import find_binding

    binding = find_binding(app)
    assert isinstance(binding, OpenReceiveBinding)
    assert find_binding(app.routes[-1].original_router) is binding  # type: ignore[attr-defined]
    with TestClient(app):
        assert app.state.openreceive is binding
        assert binding.started
    # Configuring the same pair twice is refused rather than silently merged.
    with pytest.raises(ConfigurationError):
        openreceive_router(binding.host, engine=binding.engine, rate_limiting=True)


def test_lifespan_preflight_failure_stops_startup(tmp_path: Path) -> None:
    class SpendCapableWallet(FakeWallet):
        def preflight(self) -> dict[str, Any]:
            info = super().preflight()
            return {**info, "methods": [*info["methods"], "pay_invoice"]}

    app, _shop, _wallet, _engine = build(tmp_path, wallet=SpendCapableWallet())
    with pytest.raises(ConfigurationError, match="spend"):
        with TestClient(app):
            pass


def test_missing_nwc_uri_fails_closed_and_never_prints_a_secret(tmp_path: Path) -> None:
    app, _shop, _wallet, _engine = build(tmp_path, inject_wallet=False, env={})
    with pytest.raises(ConfigurationError, match="NWC_URI is not set") as failure:
        with TestClient(app):
            pass
    from openreceive.nwc.uri import SCHEME

    assert SCHEME not in str(failure.value)


def test_lazy_lifespan_answers_503_until_configured(tmp_path: Path) -> None:
    app, _shop, _wallet, _engine = build(tmp_path, inject_wallet=False, env={}, lazy=True)
    with TestClient(app) as client:
        alice(client)
        response = post(client, "/checkouts/prepare", {"reference": REFERENCE})
        assert response.status_code == 503
        body = response.json()
        assert body["code"] == "WALLET_UNAVAILABLE" and body["retryable"] is True
        assert "NWC_URI is not set" in body["message"]


def test_built_in_rate_limit_counts_the_starlette_client(tmp_path: Path) -> None:
    app, shop, _wallet, _engine = build(tmp_path, rate_limiting={"limit_per_hour": 1})
    shop.host.amount_for = lambda reference: {"sats": 1000}
    with TestClient(app) as client:
        alice(client)
        first = post(client, "/checkouts", {"reference": "order-1"})
        assert first.status_code == 201
        second = post(client, "/checkouts", {"reference": "order-2"})
        assert second.status_code == 429 and second.json()["code"] == "RATE_LIMITED"
