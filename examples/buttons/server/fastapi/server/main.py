"""Buy a Button on FastAPI — the MINIMAL host: the packaged React `<Checkout>`
against `openreceive_router`, and nothing else in the payment column.

    uv run uvicorn server.asgi:app --port 3007

The shop's five JSON routes, the artwork mount and the built SPA are the
host's; the OpenReceive routes are the engine's, included under
`/openreceive`. The three hooks below are the whole bridge.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import create_engine

from openreceive.fastapi import openreceive_lifespan, openreceive_router
from openreceive.server import Host
from openreceive.storage import PaymentSettlement
from openreceive.testing import FakeSwapProvider, FakeWallet, StaticPriceProvider

from . import shop
from .testkit import testkit_router

OPENRECEIVE_PREFIX = "/openreceive"
DEMO_ROOT = Path(__file__).resolve().parents[1]
DIST_DIR = DEMO_ROOT / "dist"
log = logging.getLogger("buttons.fastapi")


def create_app(env: dict[str, str] | None = None) -> FastAPI:
    env = dict(os.environ if env is None else env)
    logging.basicConfig(
        level=env.get("LOG_LEVEL", "INFO").upper(), format="%(name)s %(levelname)s %(message)s"
    )

    # ONE database: the shop's four tables and the engine's two. SQLite in the
    # data directory (a volume in Docker, a temp dir under the E2E harness),
    # Postgres when DATABASE_URL says so.
    data_dir = Path(env.get("OPENRECEIVE_DEMO_DB") or DEMO_ROOT.parents[1] / ".data").resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    url = env.get("DATABASE_URL") or f"sqlite:///{data_dir / 'fastapi.sqlite'}"
    engine = create_engine(url.replace("postgres://", "postgresql+psycopg://", 1))
    store = shop.Store(engine)
    store.migrate()
    secret = shop.resolve_cookie_secret(data_dir, env)

    # `DEMO_WALLET=testkit` swaps ONLY the wallet, the swap provider and the
    # price feed for the in-memory fakes — no NWC_URI, no network. Everything
    # else is the production path, which is what makes the E2E suite worth trusting.
    testkit = (FakeWallet(), FakeSwapProvider()) if env.get("DEMO_WALLET") == "testkit" else None

    # ---- THE THREE HOOKS. OpenReceive sees an order only through these.
    def authorize(context: Any) -> bool:
        """Possession of an order id is a CLAIM: the order must belong to the
        browser whose signed cookie is on the Starlette request."""
        order = store.order(context.resource.get("reference"))
        visitor = shop.read_signed_cookie(context.request.cookies.get(shop.SHOP_COOKIE), secret)
        return order is not None and visitor is not None and order.row["shop_user_id"] == visitor

    def amount_for(reference: str) -> dict[str, str] | None:
        """The price from OUR OWN ROW — a decimal string from integer cents —
        plus what the payer is buying. None: nothing to pay for (404)."""
        order = store.order(reference)
        if order is None:
            return None
        return {
            "currency": order.row["currency"],
            "value": shop.format_amount(order.row["total_cents"]),
            "description": order.description(),
        }

    def on_paid(settlement: PaymentSettlement) -> None:
        """Inside the settlement transaction, first settled attempt only. The
        guarded UPDATE runs on the transaction's own connection, so the order
        flip commits with the payment record. Database writes only."""
        assert settlement.connection is not None
        if shop.claim_order_paid(
            settlement.connection, settlement.reference, settlement.paid_at, settlement.payment_hash
        ):
            log.info(
                "openreceive.on_paid reference=%s payment_hash=%s — order paid, downloads unlocked",
                settlement.reference,
                settlement.payment_hash,
            )

    host = Host(amount_for=amount_for, authorize=authorize, on_paid=on_paid)
    router = openreceive_router(
        host,
        engine=engine,
        # Public web shop: cap invoice creation per client IP (uvicorn
        # --proxy-headers makes request.client the payer behind a proxy).
        rate_limiting=True,
        env=env,
        **(
            {
                "nwc_client": testkit[0],
                "swap_providers": [testkit[1]],
                "price_provider": StaticPriceProvider(),
            }
            if testkit
            else {}
        ),
    )
    app = FastAPI(
        lifespan=openreceive_lifespan(host, engine=engine),
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.include_router(router, prefix=OPENRECEIVE_PREFIX)
    app.include_router(testkit_router(testkit), prefix="/__testkit")
    if testkit:
        log.info(
            "openreceive.testkit wallet mode: in-memory fakes, no NWC connection (/__testkit live)"
        )

    # ---- The shop's own JSON API. OpenReceive owns none of it.
    def visitor(request: Request, response: Response) -> dict[str, Any]:
        user, cookie = store.visitor(request.cookies.get(shop.SHOP_COOKIE), secret)
        response.set_cookie(
            shop.SHOP_COOKIE,
            cookie,
            max_age=shop.COOKIE_MAX_AGE_SECONDS,
            path="/",
            httponly=True,
            samesite="lax",
            secure=request.url.scheme == "https",
        )
        response.headers["Cache-Control"] = "no-store"
        return user

    @app.get("/shop/bootstrap")
    def bootstrap(request: Request, response: Response) -> dict[str, Any]:
        user = visitor(request, response)
        catalog = [
            {
                "sku": p["sku"],
                "name": p["name"],
                "price_cents": p["price_cents"],
                "image_url": shop.image_url(p["image_name"]),
            }
            for p in store.catalog()
        ]
        return {
            "shop": {
                "currency": "USD",
                "max_per_sku": shop.MAX_PER_SKU,
                "openreceive_prefix": OPENRECEIVE_PREFIX,
                "catalog": catalog,
                "visitor": {"public_ref": user["public_ref"]},
            }
        }

    @app.post("/shop/orders", status_code=201)
    async def create_order(request: Request, response: Response) -> Any:
        user = visitor(request, response)
        body = await request.json() if await request.body() else {}
        order = store.create_order(
            body.get("items") if isinstance(body, dict) else None, str(user["id"])
        )
        if order is None:
            return JSONResponse(
                {"error": "Your cart is empty."}, status_code=422, headers=dict(response.headers)
            )
        return shop.order_payload(order)

    def owned_order(request: Request, response: Response, reference: str) -> shop.Order | None:
        """Another visitor's order is a 404 and never a 403: do not confirm an id exists."""
        user = visitor(request, response)
        order = store.order(reference)
        return order if order is not None and order.row["shop_user_id"] == user["id"] else None

    @app.get("/shop/orders/{reference}")
    def show_order(request: Request, response: Response, reference: str) -> Any:
        order = owned_order(request, response, reference)
        if order is None:
            return JSONResponse(
                {"error": "Not found."}, status_code=404, headers=dict(response.headers)
            )
        return shop.order_payload(order)

    @app.get("/shop/orders/{reference}/downloads/{sku}")
    def download(request: Request, response: Response, reference: str, sku: str) -> Any:
        """Fulfillment is gated on the ORDER ROW, flipped only in on_paid."""
        order = owned_order(request, response, reference)
        if order is None:
            return JSONResponse(
                {"error": "Not found."}, status_code=404, headers=dict(response.headers)
            )
        if not order.paid:
            return JSONResponse(
                {"error": "Not paid."}, status_code=403, headers=dict(response.headers)
            )
        item = next((item for item in order.items if item["sku"] == sku), None)
        name = Path(item["image_name"] or f"openreceive-{sku}-button.webp").name if item else None
        if name is None or not (shop.ARTWORK_DIR / name).exists():
            return JSONResponse(
                {"error": "Not found."}, status_code=404, headers=dict(response.headers)
            )
        return FileResponse(
            shop.ARTWORK_DIR / name,
            media_type="image/webp",
            filename=name,
            headers=dict(response.headers),
        )

    @app.get("/shop/recent_orders")
    def recent_orders() -> JSONResponse:
        """Public, paid-only, identical for everyone — so it caches. No visitor is minted here."""
        orders, totals = store.recent_orders()
        return JSONResponse(
            {
                "orders": [shop.feed_payload(order, buyer) for order, buyer in orders],
                "totals": totals,
            },
            headers={"Cache-Control": "public, max-age=10"},
        )

    # Catalog thumbnails are public; the download above deliberately bypasses this mount.
    app.mount("/images", StaticFiles(directory=shop.ARTWORK_DIR), name="images")

    # Production: the built Vite bundle, index.html for every other GET so
    # /checkout/:reference survives a reload. In development Vite is the front
    # door and this never fires.
    if DIST_DIR.exists():
        app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            candidate = (DIST_DIR / path).resolve()
            if path and candidate.is_file() and DIST_DIR in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(DIST_DIR / "index.html")

    return app
