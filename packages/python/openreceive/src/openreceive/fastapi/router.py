"""`openreceive_router(host, engine=…)`: an `APIRouter` serving every
OpenReceive route through the framework-free engine.

    app.include_router(openreceive_router(host, engine=engine), prefix="/openreceive")

The endpoint is a plain `def`, which Starlette runs in its threadpool — the
engine is synchronous (one wallet RPC is one blocking call bounded by the
service's deadline), and a second async engine would be a second settlement
implementation. The one catch-all route hands the prefix-relative path to
the engine, so 404 vs 405, the JSON content-type gate, the cross-site
refusal, the declared-fields check and the 64 KB cap are all the engine's,
identical to the Django, Express and Rails mounts.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from fastapi import APIRouter
from starlette.requests import Request
from starlette.responses import Response

from openreceive.fastapi.binding import OpenReceiveBinding, binding_for
from openreceive.fastapi.requests import http_request_from_starlette, starlette_response
from openreceive.server.errors import ConfigurationError
from openreceive.server.handler import HookContext, HttpResponse
from openreceive.server.hosts import Host
from openreceive.server.service import redact_secrets
from openreceive.storage.repository import PaymentRepository

ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


class OpenReceiveRouter(APIRouter):
    """An APIRouter that also names the binding behind it, for the CLI
    (`openreceive doctor --app main:router`)."""

    openreceive: OpenReceiveBinding


def openreceive_router(
    host: Host,
    *,
    engine: Any | None = None,
    repository: PaymentRepository | None = None,
    service: Any | None = None,
    nwc_client: Any | None = None,
    price_provider: Any | None = None,
    swap_providers: list[Any] | None = None,
    price_currencies: list[str] | None = None,
    allow_spend_capable_wallet: bool = False,
    env: Mapping[str, str] | None = None,
    logger: Any | None = None,
    table_name: str = "openreceive_payments",
    meta_table_name: str = "openreceive_meta",
    rate_limiting: bool | Mapping[str, Any] = False,
    rate_limit: Callable[[HookContext], bool] | None = None,
    client_ip: Callable[[Any], str | None] | None = None,
    opportunistic_reconcile: bool | Mapping[str, Any] = True,
    clock: Callable[[], int] | None = None,
    report_unexpected_error: Callable[[BaseException, str], None] | None = None,
) -> OpenReceiveRouter:
    """`engine` is OpenReceive's own sync SQLAlchemy `Engine` for its two
    tables (same database as the host; on SQLite give it a dedicated Engine,
    the repository configures it for serialized writers). `authorize` on the
    host receives the Starlette `Request`. `rate_limiting=True` caps invoice
    creation per client IP (`request.client.host`, so run uvicorn with
    `--proxy-headers` behind a reverse proxy). Wallet, price feed and swap
    providers come from the environment (`NWC_URI`, `LSC_URI_*`) unless
    `nwc_client` / `price_provider` / `swap_providers` inject them — the
    test seam, and the `openreceive.testing` fakes fit it."""
    binding = binding_for(
        host,
        engine=engine,
        repository=repository,
        options={
            "service": service,
            "nwc_client": nwc_client,
            "price_provider": price_provider,
            "swap_providers": swap_providers,
            "price_currencies": price_currencies,
            "allow_spend_capable_wallet": allow_spend_capable_wallet,
            "env": env,
            "logger": logger,
            "table_name": table_name,
            "meta_table_name": meta_table_name,
            "rate_limiting": rate_limiting,
            "rate_limit": rate_limit,
            "client_ip": client_ip,
            "opportunistic_reconcile": opportunistic_reconcile,
            "clock": clock,
            "report_unexpected_error": report_unexpected_error,
        },
    )
    router = OpenReceiveRouter()
    router.openreceive = binding

    @router.api_route("/{rest:path}", methods=ROUTE_METHODS, include_in_schema=False)
    def openreceive_endpoint(request: Request, rest: str) -> Response:
        return dispatch(binding, request, rest)

    # The CLI finds the binding on a FastAPI app by walking its routes.
    openreceive_endpoint.openreceive_binding = binding  # type: ignore[attr-defined]
    return router


def dispatch(binding: OpenReceiveBinding, request: Request, rest: str) -> Response:
    """One request through the engine. A stack that cannot boot (lazy mode
    with a missing or refused wallet) answers 503 WALLET_UNAVAILABLE, the
    Node adapters' shape, instead of a traceback."""
    try:
        app = binding.app
    except ConfigurationError as error:
        return starlette_response(
            HttpResponse(
                503,
                {
                    "code": "WALLET_UNAVAILABLE",
                    "message": f"OpenReceive is not configured: {redact_secrets(str(error))}",
                    "retryable": True,
                },
                {},
            )
        )
    http_request = http_request_from_starlette(request, path=f"/{rest.lstrip('/')}")
    return starlette_response(app.handle(http_request))
