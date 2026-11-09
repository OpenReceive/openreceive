"""One app process of a two-instance shop on real Postgres or MySQL, driven by
tests/deployment/two-instances.test.mjs (the contract is at the top of that
file). A framework-free `OpenReceiveApp` behind a threading HTTP server."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from sqlalchemy import create_engine, text

from openreceive.server.app import OpenReceiveApp
from openreceive.server.handler import HttpRequest
from openreceive.server.hosts import Host
from openreceive.server.service import Service
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.testing.fake_swap_provider import FakeSwapProvider

INSTANCE = os.environ["EDGE_INSTANCE"]
KIND = os.environ["EDGE_DB_KIND"]
URL = os.environ["EDGE_DB_URL"]
WALLET_URL = os.environ["EDGE_WALLET_URL"]
LIMIT = int(os.environ.get("EDGE_RATE_LIMIT_PER_HOUR", "60"))


def sqlalchemy_url(url: str) -> str:
    if url.startswith("mysql://"):
        return url.replace("mysql://", "mysql+pymysql://", 1)
    return url.replace("postgresql://", "postgresql+psycopg://", 1)


def post_wallet(path: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        WALLET_URL + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "x-edge-instance": INSTANCE},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read() or b"{}")


class SharedWalletClient:
    def preflight(self) -> dict[str, Any]:
        return {
            "wallet_pubkey": "f" * 64,
            "relays": ["wss://relay.test.openreceive.local"],
            "methods": ["make_invoice", "list_transactions"],
            "encryption": ["nip04"],
        }

    def make_invoice(self, params: dict[str, Any]) -> dict[str, Any]:
        return post_wallet("/make_invoice", params)

    def list_transactions(self, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return post_wallet("/list_transactions", params or {})


engine = create_engine(sqlalchemy_url(URL), pool_size=16, max_overflow=16)


def migrate() -> None:
    repository = SqlPaymentRepository(engine)
    repository.create_tables()
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE edge_fulfillments (reference VARCHAR(255) NOT NULL, "
                "payment_hash VARCHAR(64) NOT NULL, instance VARCHAR(16) NOT NULL)"
            )
        )


def on_paid(settlement: Any) -> None:
    settlement.connection.execute(
        text(
            "INSERT INTO edge_fulfillments (reference, payment_hash, instance) "
            "VALUES (:reference, :payment_hash, :instance)"
        ),
        {
            "reference": settlement.reference,
            "payment_hash": settlement.payment_hash,
            "instance": INSTANCE,
        },
    )
    post_wallet(
        "/fulfilled",
        {
            "reference": settlement.reference,
            "payment_hash": settlement.payment_hash,
            "instance": INSTANCE,
        },
    )


def build_app() -> OpenReceiveApp:
    repository = SqlPaymentRepository(engine)
    host = Host(
        amount_for=lambda _reference: {"sats": 1234},
        authorize=lambda _context: True,
        on_paid=on_paid,
    )
    service = Service(
        SharedWalletClient(), price_provider=False, swap_providers=[FakeSwapProvider()]
    )
    return OpenReceiveApp(
        service=service,
        host=host,
        repository=repository,
        rate_limiting={"limit_per_hour": LIMIT},
        client_ip=lambda request: getattr(request, "header", lambda _name: None)(
            "x-edge-client-ip"
        ),
    )


APP: OpenReceiveApp | None = None


def wait_until(at_ms: int | None) -> None:
    if not at_ms:
        return
    delay = int(at_ms) / 1000 - time.time()
    if delay > 0:
        time.sleep(delay)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args: Any) -> None:
        pass

    def send_json(self, status: int, body: Any, headers: dict[str, str] | None = None) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        for key, value in (headers or {}).items():
            if key.lower() not in ("content-type", "content-length"):
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path.split("?")[0] == "/__health":
            self.send_json(200, {"instance": INSTANCE})
        else:
            self.dispatch(b"")

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        path = self.path.split("?")[0]
        try:
            if path == "/__settle":
                body = json.loads(raw)
                wait_until(body.get("at_ms"))
                assert APP is not None
                APP.reconciler.settle(
                    {"payment_hash": body["payment_hash"], "paid_at": body["paid_at"]}
                )
                self.send_json(200, {"ok": True})
                return
            if path == "/__reconcile":
                body = json.loads(raw or b"{}")
                wait_until(body.get("at_ms"))
                assert APP is not None
                self.send_json(200, {"reason": APP.reconciler.maybe_reconcile().get("reason")})
                return
            if path == "/__notify":
                body = json.loads(raw)
                wait_until(body.get("at_ms"))
                assert APP is not None
                APP.reconciler.handle_notification(
                    {"notification_type": "payment_received", "notification": body["transaction"]}
                )
                self.send_json(200, {"ok": True})
                return
        except Exception as error:  # noqa: BLE001 - reported to the test as a 500
            self.send_json(500, {"error": repr(error)})
            return
        self.dispatch(raw)

    def dispatch(self, raw: bytes) -> None:
        assert APP is not None
        headers = {key: value for key, value in self.headers.items()}
        path, _, query = self.path.partition("?")
        request = HttpRequest(
            method=self.command,
            path=path,
            query_string=query,
            headers=headers,
            body=raw,
            content_length=len(raw),
            remote_addr=self.client_address[0],
        )
        try:
            response = APP.handle(request)
        except Exception as error:  # noqa: BLE001 - reported to the test as a 500
            self.send_json(500, {"error": repr(error)})
            return
        self.send_json(response.status, response.body, response.headers)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64


def main() -> None:
    global APP
    if "migrate" in sys.argv:
        migrate()
        return
    APP = build_app()
    server = Server(("127.0.0.1", int(os.environ["EDGE_PORT"])), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Event().wait()


if __name__ == "__main__":
    main()
