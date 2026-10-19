"""The checkout page and the engine's routes.

`/payment/openreceive/checkout` is where Odoo's payment form sends the buyer
after it created the transaction: a page on the shop with the OpenReceive
checkout for that transaction. `/openreceive/...` are the routes that checkout
calls. Each one hands the request to the engine, which owns the routing, the
JSON-only and cross-site gates and the error contract; this file adds Odoo's
own CSRF token, read from the `X-CSRF-Token` header the checkout sends.
"""

import json
import logging
import uuid

from odoo import http
from odoo.http import request

from openreceive.server import HttpRequest
from openreceive.server.errors import ForbiddenError
from openreceive.server.service import sanitize_failure_message

from .. import const, runtime

_logger = logging.getLogger(__name__)

SAFE_METHODS = ("GET", "HEAD", "OPTIONS", "TRACE")
MAX_BODY_BYTES = 1024 * 1024


def _json(status, body, headers=None):
    response = request.make_response(
        json.dumps(body, separators=(",", ":"), ensure_ascii=False),
        headers=[("Content-Type", "application/json; charset=utf-8"), ("Cache-Control", "no-store")]
        + list((headers or {}).items()),
    )
    response.status_code = status
    return response


def _unavailable(message):
    request_id = f"req_{uuid.uuid4()}"
    return _json(
        503,
        {
            "code": "WALLET_UNAVAILABLE",
            "message": message,
            "retryable": True,
            "request_id": request_id,
        },
        {"x-request-id": request_id},
    )


class OpenReceiveController(http.Controller):
    @http.route(
        const.CHECKOUT_ROUTE,
        type="http",
        auth="public",
        methods=["GET"],
        sitemap=False,
        website=True,
    )
    def openreceive_checkout(self, reference=None, **_kwargs):
        """The checkout for the transaction this browser session is paying.
        Anyone else gets the payment status page, which shows them nothing."""
        tx = runtime.find_transaction(request.env, str(reference or ""))
        if not tx or not runtime.is_session_payer(request, tx):
            return request.redirect(const.STATUS_ROUTE)
        if tx.state not in const.PAYABLE_STATES:
            return request.redirect(const.STATUS_ROUTE)
        return request.render(
            "payment_openreceive.checkout_page",
            {
                "tx": tx,
                "reference": tx.reference,
                "prefix": const.ROUTE_PREFIX,
                "return_url": const.STATUS_ROUTE,
                "asset_path": const.ASSET_PATH,
                "csrf_value": request.csrf_token(),
            },
        )

    @http.route(
        [f"{const.ROUTE_PREFIX}/<path:route>"],
        type="http",
        auth="public",
        methods=["GET", "HEAD", "POST", "OPTIONS"],
        csrf=False,
        sitemap=False,
        save_session=False,
        # Werkzeug refuses a larger body before anything reads it; the engine
        # answers bodies over its own, smaller cap with its JSON error.
        max_content_length=MAX_BODY_BYTES,
    )
    def openreceive_engine(self, route=None, **_kwargs):
        try:
            app = runtime.get_app(request.env)
        except runtime.NotConfigured:
            return _unavailable("This payment method is not set up yet.")
        except Exception as error:
            _logger.warning(
                "OpenReceive: the engine could not start: %s", sanitize_failure_message(error)
            )
            return _unavailable("The wallet is not reachable right now. Try again shortly.")
        httprequest = request.httprequest
        if httprequest.method not in SAFE_METHODS:
            token = httprequest.headers.get("X-CSRF-Token", "")
            if not token or not request.validate_csrf(token):
                request_id = f"req_{uuid.uuid4()}"
                status, body, headers = app.handler.error_response(
                    ForbiddenError("Invalid or missing CSRF token."), request_id
                )
                return _json(status, body, headers)
        wire = HttpRequest(
            method=httprequest.method,
            path=httprequest.path,
            query_string=httprequest.query_string.decode("latin-1"),
            headers=dict(httprequest.headers.items()),
            # A reader: the engine reads only after the route matched.
            body=lambda max_bytes: httprequest.get_data()[:max_bytes],
            content_length=httprequest.content_length,
            remote_addr=httprequest.remote_addr,
            framework_request=request,
        )
        status, body, headers = app.handle(wire)
        return _json(status, body, headers)
