"""One thin view per route. Each converts the Django request into the wire
`HttpRequest` the framework-free handler reads — method, body reader, headers,
Content-Length, REMOTE_ADDR, and the Django request itself for the host's
hooks — hands it to `OpenReceiveApp.handle`, and renders the (status, body,
headers) triple. Nothing about routing, authorization, the body cap, the
JSON-only gate or the cross-site refusal lives here.

The wire path is normalized to the app's own prefix plus the route suffix, so
where the host mounts `openreceive.django.urls` does not matter to the engine.

CSRF: the host's `CsrfViewMiddleware` stays in charge — its settings, its
cookie, its token. The views are marked exempt only so that the SAME middleware
can be run here, inside the view, and a failure answered with the shared 403
error contract (`{"code": "FORBIDDEN", …}`) instead of the host's HTML failure
page — the Rails engine's `rescue_from InvalidAuthenticityToken` twin. A host
with no CSRF middleware installed gets no CSRF check, exactly as before; the
engine's own JSON-only and same-site gates still apply.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

from django.conf import settings
from django.http import HttpRequest as DjangoRequest
from django.http import HttpResponse as DjangoResponse
from django.middleware.csrf import CsrfViewMiddleware
from django.utils.module_loading import import_string
from django.views.decorators.csrf import csrf_exempt

from openreceive.django import conf
from openreceive.server import HttpRequest, HttpResponse
from openreceive.server.errors import ForbiddenError

CSRF_FAILURE_MESSAGE = "Invalid or missing CSRF token."

_csrf_middleware_classes: list[type[CsrfViewMiddleware]] | None = None


def _csrf_middlewares() -> list[type[CsrfViewMiddleware]]:
    """Every CsrfViewMiddleware (or subclass) the host runs, resolved once."""
    global _csrf_middleware_classes
    if _csrf_middleware_classes is None:
        found: list[type[CsrfViewMiddleware]] = []
        for dotted in getattr(settings, "MIDDLEWARE", None) or []:
            try:
                candidate = import_string(dotted)
            except ImportError:
                continue
            if isinstance(candidate, type) and issubclass(candidate, CsrfViewMiddleware):
                found.append(candidate)
        _csrf_middleware_classes = found
    return _csrf_middleware_classes


def _csrf_probe(request: DjangoRequest) -> DjangoResponse:  # pragma: no cover - never called
    """A NON-exempt callback for the middleware's view check: the mounted views
    carry `csrf_exempt` (so the middleware in the stack defers to this
    in-view check), and the middleware would skip an exempt callback."""
    return DjangoResponse()


def _csrf_rejected(request: DjangoRequest) -> bool:
    """Run the host's CSRF middleware's own view check against this request."""
    for middleware in _csrf_middlewares():
        instance = middleware(lambda _request: DjangoResponse())
        # The check reads the request only; the response it would build is the
        # host's HTML failure page, which we replace with the JSON contract.
        if instance.process_view(request, _csrf_probe, (), {}) is not None:
            return True
    return False


def _wire_request(request: DjangoRequest, route: str, prefix: str) -> HttpRequest:
    declared = request.META.get("CONTENT_LENGTH")
    content_length: int | None
    try:
        content_length = int(declared) if declared not in (None, "") else None
    except (TypeError, ValueError):
        content_length = None
    return HttpRequest(
        method=request.method or "GET",
        path=f"{prefix}{route}",
        query_string=request.META.get("QUERY_STRING", "") or "",
        headers={key: value for key, value in request.headers.items()},
        # A reader, not the bytes: the engine reads at most MAX_BODY_BYTES+1
        # and only after the route matched.
        body=lambda max_bytes: request.read(max_bytes),
        content_length=content_length,
        remote_addr=conf.client_ip(request),
        framework_request=request,
    )


def _render(response: HttpResponse) -> DjangoResponse:
    status, _body, headers = response
    rendered = DjangoResponse(response.json(), status=status, content_type="application/json")
    for key, value in headers.items():
        if key.lower() != "content-type":
            rendered[key] = value
    return rendered


def _dispatch(request: DjangoRequest, route: str) -> DjangoResponse:
    app = conf.get_app()
    if request.method not in ("GET", "HEAD", "OPTIONS", "TRACE") and _csrf_rejected(request):
        request_id = f"req_{uuid.uuid4()}"
        return _render(app.handler.error_response(ForbiddenError(CSRF_FAILURE_MESSAGE), request_id))
    return _render(app.handle(_wire_request(request, route, app.prefix)))


def _route(route: str) -> Callable[[DjangoRequest], DjangoResponse]:
    @csrf_exempt
    def view(request: DjangoRequest) -> DjangoResponse:
        return _dispatch(request, route)

    view.__name__ = "openreceive_" + route.strip("/").replace("/", "_")
    return view


prepare_checkout = _route("/checkouts/prepare")
create_checkout = _route("/checkouts")
check_payment = _route("/payments/check")
quote_swap = _route("/swaps/quote")
create_swap = _route("/swaps")
swap_status = _route("/swaps/status")
refund_swap = _route("/swaps/refunds")
rates = _route("/rates")
