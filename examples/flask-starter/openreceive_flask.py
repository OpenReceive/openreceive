# openreceive_flask.py: OpenReceive for Flask. Copy this file into your app.
"""The OpenReceive routes as a Flask Blueprint over the framework-free engine.

`host` and `repository` are what `openreceive doctor --app app:openreceive`
reads, without touching the wallet. `start()` builds the stack once; building
the Service is the receive-only wallet check, so call it where the app boots.
"""

import os
import threading

from flask import Blueprint, Response, request

from openreceive.nwc.receive_client import NwcReceiveClient
from openreceive.server import (
    ConfigurationError,
    HttpRequest,
    HttpResponse,
    OpenReceiveApp,
    Service,
)
from openreceive.server.service import redact_secrets
from openreceive.storage.sql import SqlPaymentRepository

METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


class OpenReceiveFlask:
    def __init__(self, host, engine, *, rate_limiting=False):
        self.host = host
        # OpenReceive's own repository over your Engine: its two tables,
        # the per-reference lock, write-once settlement and the reconcile gate.
        self.repository = SqlPaymentRepository(engine)
        self.rate_limiting = rate_limiting
        self._app = None
        self._lock = threading.Lock()

    def start(self):
        """Build the stack once. Raises ConfigurationError when NWC_URI is
        missing, unreachable or able to spend."""
        with self._lock:
            if self._app is None:
                nwc = os.environ.get("NWC_URI", "").strip()
                if not nwc:
                    raise ConfigurationError(
                        "NWC_URI is not set. Get a receive-only code: "
                        "https://openreceive.org/get_a_nwc_code_to_receive_payments"
                    )
                self._app = OpenReceiveApp(
                    # Service reads LSC_URI_* for swaps and refuses a code that can spend.
                    service=Service(NwcReceiveClient(nwc)),
                    host=self.host,
                    repository=self.repository,
                    prefix="",
                    rate_limiting=self.rate_limiting,
                )
            return self._app

    @property
    def app(self):
        return self.start()

    def blueprint(self, url_prefix="/openreceive"):
        bp = Blueprint("openreceive", __name__, url_prefix=url_prefix)

        @bp.route("/<path:rest>", methods=METHODS)
        def dispatch(rest):
            try:
                app = self.app
            except ConfigurationError as error:
                response = HttpResponse(
                    503,
                    {
                        "code": "WALLET_UNAVAILABLE",
                        "message": f"OpenReceive is not configured: {redact_secrets(str(error))}",
                        "retryable": True,
                    },
                    {},
                )
            else:
                bodyless = request.method in ("GET", "HEAD", "OPTIONS")
                response = app.handle(
                    HttpRequest(
                        method=request.method,
                        path=f"/{rest}",
                        query_string=request.query_string.decode(),
                        headers=dict(request.headers),
                        # A reader: the engine caps the body before it reads it.
                        body=None if bodyless else request.stream.read,
                        content_length=request.content_length,
                        remote_addr=request.remote_addr,
                        # What `authorize` gets as `context.request`.
                        framework_request=request,
                    )
                )
            return Response(
                response.json(), response.status, response.headers, mimetype="application/json"
            )

        return bp
