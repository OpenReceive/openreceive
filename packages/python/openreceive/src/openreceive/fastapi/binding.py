"""One `OpenReceiveBinding` per (host, engine): the Service (whose constructor
IS the fail-closed wallet preflight), OpenReceive's own SQLAlchemy repository
over the host's `Engine`, and the storage-aware `OpenReceiveApp`, built once
and shared by the router that serves requests and the lifespan that runs the
preflight at startup.

Why a registry: the quickstart spells the two halves independently —
`FastAPI(lifespan=openreceive_lifespan(host, engine=engine))` and
`app.include_router(openreceive_router(host, engine=engine), prefix=…)` — and
both must reach the SAME service, or the wallet would be probed twice and the
router would boot a second stack the lifespan never checked. The key is the
identity of the host and the engine (or custom repository), which live for
the process; the binding holds strong references, so an id is never reused
under a live entry.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable, Mapping
from typing import Any

from openreceive.nwc.uri import NWC_CODE_HELP_URL
from openreceive.server.app import OpenReceiveApp
from openreceive.server.errors import ConfigurationError
from openreceive.server.handler import HookContext
from openreceive.server.hosts import Host
from openreceive.server.service import Service
from openreceive.storage.repository import PaymentRepository

log = logging.getLogger("openreceive")

NWC_URI_ENV = "NWC_URI"
MISSING_NWC_URI_MESSAGE = (
    f"{NWC_URI_ENV} is not set. OpenReceive needs a receive-only NWC code in the server "
    f"environment (never in browser code). Get one here: {NWC_CODE_HELP_URL}"
)


def default_client_ip(request: Any) -> str | None:
    """The peer address Starlette recorded — the payer, once
    `ProxyHeadersMiddleware` (uvicorn `--proxy-headers`) has rewritten it
    behind a reverse proxy. Override with `client_ip=` for another header."""
    client = getattr(request, "client", None)
    host = getattr(client, "host", None)
    return str(host) if host else None


class OpenReceiveBinding:
    def __init__(
        self,
        host: Host,
        *,
        engine: Any | None = None,
        repository: PaymentRepository | None = None,
        service: Service | None = None,
        nwc_client: Any | None = None,
        price_provider: Any | None = None,
        swap_providers: list[Any] | None = None,
        price_currencies: list[str] | None = None,
        allow_spend_capable_wallet: bool = False,
        env: Mapping[str, str] | None = None,
        logger: logging.Logger | None = None,
        table_name: str = "openreceive_payments",
        meta_table_name: str = "openreceive_meta",
        rate_limiting: bool | Mapping[str, Any] = False,
        rate_limit: Callable[[HookContext], bool] | None = None,
        client_ip: Callable[[Any], str | None] | None = None,
        opportunistic_reconcile: bool | Mapping[str, Any] = True,
        clock: Callable[[], int] | None = None,
        report_unexpected_error: Callable[[BaseException, str], None] | None = None,
    ) -> None:
        if engine is None and repository is None:
            raise ConfigurationError(
                "openreceive_router / openreceive_lifespan need `engine=` (a sync SQLAlchemy Engine for "
                "OpenReceive's two tables) or `repository=` (a custom PaymentRepository). "
                "https://openreceive.org/guides/storage.md"
            )
        self.host = host
        self.engine = engine
        self._repository = repository
        self._service = service
        self._owns_client = service is None and nwc_client is None
        self._nwc_client = nwc_client
        self._price_provider = price_provider
        self._swap_providers = swap_providers
        self._price_currencies = price_currencies
        self._allow_spend_capable_wallet = allow_spend_capable_wallet
        self._env = env
        self._logger = logger
        self._table_name = table_name
        self._meta_table_name = meta_table_name
        self._app_options: dict[str, Any] = {
            "rate_limiting": rate_limiting,
            "rate_limit": rate_limit,
            "client_ip": client_ip or default_client_ip,
            "opportunistic_reconcile": opportunistic_reconcile,
            "clock": clock,
            "report_unexpected_error": report_unexpected_error,
        }
        self._app: OpenReceiveApp | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------ lifecycle

    @property
    def started(self) -> bool:
        return self._app is not None

    def start(self) -> OpenReceiveApp:
        """Build the stack — the wallet preflight included — once. Raises
        `ConfigurationError` (a missing NWC_URI, a spend-capable or unreachable
        wallet) so a lifespan that calls this stops the process."""
        with self._lock:
            if self._app is None:
                self._app = OpenReceiveApp(
                    service=self.service,
                    host=self.host,
                    repository=self.repository,
                    # The router strips the mount prefix before dispatch, so the
                    # engine sees prefix-relative paths whatever `include_router`
                    # was told.
                    prefix="",
                    **self._app_options,
                )
            return self._app

    @property
    def app(self) -> OpenReceiveApp:
        return self.start()

    @property
    def service(self) -> Service:
        if self._service is None:
            self._service = Service(
                self._nwc_client or self._build_nwc_client(),
                price_provider=self._price_provider,
                swap_providers=self._swap_providers,
                price_currencies=self._price_currencies,
                allow_spend_capable_wallet=self._allow_spend_capable_wallet,
                env=self._env,
                logger=self._logger or log,
            )
        return self._service

    @property
    def repository(self) -> PaymentRepository:
        """Built without touching the wallet, so the doctor can probe the
        tables on a box with no relay access."""
        if self._repository is None:
            from openreceive.storage.sql import SqlPaymentRepository

            if self.engine is None:  # pragma: no cover - guarded in __init__
                raise ConfigurationError("openreceive_router needs engine= or repository=.")
            self._repository = SqlPaymentRepository(
                self.engine,
                table_name=self._table_name,
                meta_table_name=self._meta_table_name,
            )
        return self._repository

    def close(self) -> None:
        """Close the wallet client this binding built (never one the host
        passed in — the host owns that lifecycle)."""
        if self._service is None or not self._owns_client:
            return
        closer = getattr(self._service.nwc_client, "close", None)
        if callable(closer):
            closer()

    def _build_nwc_client(self) -> Any:
        env = os.environ if self._env is None else self._env
        uri = (env.get(NWC_URI_ENV) or "").strip()
        if not uri:
            raise ConfigurationError(MISSING_NWC_URI_MESSAGE)
        from openreceive.nwc.receive_client import NwcReceiveClient

        return NwcReceiveClient(uri)


# ------------------------------------------------------------------ registry

_bindings: dict[tuple[int, int], OpenReceiveBinding] = {}
_registry_lock = threading.Lock()


def binding_for(
    host: Host,
    *,
    engine: Any | None = None,
    repository: PaymentRepository | None = None,
    options: Mapping[str, Any] | None = None,
) -> OpenReceiveBinding:
    """The binding for this (host, engine-or-repository) pair, created on
    first sight. `options` (the router's keyword arguments) configure a new
    binding; passing them for a pair that already has one is a mistake the
    caller made twice, and is refused rather than silently ignored."""
    storage = repository if repository is not None else engine
    key = (id(host), id(storage))
    with _registry_lock:
        existing = _bindings.get(key)
        if existing is not None:
            if options:
                raise ConfigurationError(
                    "openreceive_router and openreceive_lifespan were both given options for the same "
                    "host and engine. Configure the stack in ONE call (the router) and pass only "
                    "`host` and `engine=` to the other."
                )
            return existing
        binding = OpenReceiveBinding(
            host, engine=engine, repository=repository, **dict(options or {})
        )
        _bindings[key] = binding
        return binding
