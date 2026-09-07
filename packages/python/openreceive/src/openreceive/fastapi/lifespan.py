"""`openreceive_lifespan(host, engine=…)`: the fail-closed wallet preflight at
startup, as a FastAPI lifespan.

    app = FastAPI(lifespan=openreceive_lifespan(host, engine=engine))

The Fastify/Express precedent: a dead relay or a spend-capable code stops
the deploy instead of becoming a customer-facing 500 — uvicorn logs the
`ConfigurationError` and exits. `lazy=True` (tests, a secretless build step)
defers the check to the first request, which then answers 503
WALLET_UNAVAILABLE until the wallet is reachable. Either way the binding
lands on `app.state.openreceive` for the host and the CLI.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any

from starlette.concurrency import run_in_threadpool

from openreceive.fastapi.binding import OpenReceiveBinding, binding_for
from openreceive.server.hosts import Host
from openreceive.storage.repository import PaymentRepository

Lifespan = Callable[[Any], AbstractAsyncContextManager[None]]


def openreceive_lifespan(
    host: Host | OpenReceiveBinding | Any,
    *,
    engine: Any | None = None,
    repository: PaymentRepository | None = None,
    lazy: bool = False,
) -> Lifespan:
    """Accepts the same `host` + `engine=` the router took (they resolve to
    the one binding), or the router / binding itself."""
    binding = _resolve_binding(host, engine=engine, repository=repository)

    @asynccontextmanager
    async def lifespan(_app: Any) -> AsyncIterator[None]:
        if not lazy:
            # The preflight is a blocking relay round-trip; keep it off the loop.
            await run_in_threadpool(binding.start)
        state = getattr(_app, "state", None)
        if state is not None:
            state.openreceive = binding
        try:
            yield
        finally:
            await run_in_threadpool(binding.close)

    return lifespan


def _resolve_binding(
    target: Any, *, engine: Any | None, repository: PaymentRepository | None
) -> OpenReceiveBinding:
    if isinstance(target, OpenReceiveBinding):
        return target
    nested = getattr(target, "openreceive", None)
    if isinstance(nested, OpenReceiveBinding):
        return nested
    if not isinstance(target, Host):
        raise TypeError(
            "openreceive_lifespan takes the Host (with engine=…), the router from openreceive_router, "
            "or an OpenReceiveBinding"
        )
    return binding_for(target, engine=engine, repository=repository)
