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

A stack that cannot start (no NWC_URI, a malformed one, or a wallet the check
refuses) answers the shared 503 `WALLET_UNAVAILABLE` contract, retryable, like
the Node adapters: never Django's HTML 500 page, which a checkout cannot read.
The next request tries again. A relay that does not answer the first request's
wallet check does not stop the stack: the service starts, its wallet calls
answer the same 503, and the first one after a short wait checks again.
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
from openreceive.nwc.uri import NwcUriParseError
from openreceive.server import HttpRequest, HttpResponse
from openreceive.server.errors import ConfigurationError, ForbiddenError
from openreceive.server.service import sanitize_failure_message

CSRF_FAILURE_MESSAGE = "Invalid or missing CSRF token."
# The Node stack's words for a stack that did not start.
BOOT_FAILURE_MESSAGE = "The payment service is not available. Please try again shortly."

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
        rendered[key] = value
    return rendered


def _boot_failure(error: BaseException) -> HttpResponse:
    """The first-use build failed: the payer gets the JSON contract, the
    operator one sanitized line (the cause can quote the NWC URI)."""
    request_id = f"req_{uuid.uuid4()}"
    conf.log.error(
        "[openreceive] request %s failed: OpenReceive could not start: %s "
        "The next request tries again.",
        request_id,
        sanitize_failure_message(error),
    )
    return HttpResponse(
        503,
        {
            "code": "WALLET_UNAVAILABLE",
            "message": BOOT_FAILURE_MESSAGE,
            "retryable": True,
            "request_id": request_id,
        },
        {"content-type": "application/json; charset=utf-8", "x-request-id": request_id},
    )


def _dispatch(request: DjangoRequest, route: str) -> DjangoResponse:
    try:
        app = conf.get_app()
    except (ConfigurationError, NwcUriParseError) as error:
        return _render(_boot_failure(error))
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
