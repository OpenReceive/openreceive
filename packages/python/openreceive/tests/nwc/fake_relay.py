"""An in-process Nostr relay plus NWC wallet for transport tests. No network.

    with FakeRelay(FakeWallet(WALLET_SECRET)) as relay:
        transport = NwcTransport(relay.wallet.keys.pubkey, [relay.url], CLIENT_SECRET)
        transport.request("make_invoice", {"amount": 1000})
        relay.push_notification("payment_received", {"payment_hash": "ab" * 32}, transport.pubkey)

The wallet answers kind 13194 info REQs with a signed info event, decrypts kind
23194 requests with whichever mode the request's ``encryption`` tag names,
hands ``(method, params)`` to ``wallet.handler`` and replies with a signed,
encrypted kind 23195 carrying ``e`` and ``p`` tags. ``push_notification``
signs a 23197 (nip44_v2) or 23196 (nip04) event and delivers it to every
connection subscribed to that kind. ``silent=True`` accepts connections and
never answers anything.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Sequence
from typing import Any

from websockets.sync.server import Server, ServerConnection, serve

from openreceive.nwc.transport import nip04, nip44
from openreceive.nwc.transport.nip01 import KeyPair, sign_event, tag_value

KIND_INFO = 13194
KIND_REQUEST = 23194
KIND_RESPONSE = 23195
KIND_NOTIFICATION = {"nip04": 23196, "nip44_v2": 23197}

WalletHandler = Callable[[str, dict[str, Any]], dict[str, Any]]

# Test keys only: never assembled into a connection URI.
WALLET_SECRET = "11" * 32
CLIENT_SECRET = "22" * 32
STRANGER_SECRET = "33" * 32


def echo_handler(method: str, params: dict[str, Any]) -> dict[str, Any]:
    return {"result_type": method, "result": {"echo": params}}


class FakeWallet:
    """Signs info/response/notification events and decrypts requests for one wallet key."""

    def __init__(
        self,
        secret_hex: str,
        *,
        methods: Sequence[str] = ("get_info", "make_invoice", "list_transactions"),
        notifications: Sequence[str] = ("payment_received",),
        encryption: Sequence[str] | None = ("nip44_v2", "nip04"),
        handler: WalletHandler = echo_handler,
    ) -> None:
        self.keys = KeyPair(secret_hex)
        self.methods = list(methods)
        self.notifications = list(notifications)
        self.encryption = None if encryption is None else list(encryption)
        self.handler = handler
        self.requests: list[tuple[str, dict[str, Any]]] = []

    def info_event(self) -> dict[str, Any]:
        tags: list[list[str]] = []
        if self.notifications:
            tags.append(["notifications", " ".join(self.notifications)])
        if self.encryption is not None:
            tags.append(["encryption", " ".join(self.encryption)])
        return sign_event(self.keys, KIND_INFO, tags, " ".join(self.methods))

    def _shared_x(self, client_pubkey: str) -> bytes:
        return self.keys.shared_x(client_pubkey)

    def decrypt(self, content: str, client_pubkey: str, mode: str) -> dict[str, Any]:
        shared_x = self._shared_x(client_pubkey)
        if mode == "nip44_v2":
            plaintext = nip44.decrypt(content, nip44.conversation_key(shared_x))
        else:
            plaintext = nip04.decrypt(content, shared_x)
        payload: dict[str, Any] = json.loads(plaintext)
        return payload

    def encrypt(self, payload: dict[str, Any], client_pubkey: str, mode: str) -> str:
        shared_x = self._shared_x(client_pubkey)
        plaintext = json.dumps(payload)
        if mode == "nip44_v2":
            return nip44.encrypt(plaintext, nip44.conversation_key(shared_x))
        return nip04.encrypt(plaintext, shared_x)

    def answer(self, request: dict[str, Any]) -> dict[str, Any]:
        """Decrypt one kind 23194 request and build the signed kind 23195 reply."""
        mode = tag_value(request, "encryption") or "nip04"
        client_pubkey = str(request["pubkey"])
        body = self.decrypt(str(request["content"]), client_pubkey, mode)
        method, params = str(body["method"]), dict(body.get("params") or {})
        self.requests.append((method, params))
        reply = self.handler(method, params)
        tags = [["p", client_pubkey], ["e", str(request["id"])]]
        if mode == "nip44_v2":
            tags.append(["encryption", mode])
        return sign_event(self.keys, KIND_RESPONSE, tags, self.encrypt(reply, client_pubkey, mode))

    def notification_event(
        self,
        notification_type: str,
        notification: dict[str, Any],
        client_pubkey: str,
        *,
        mode: str = "nip44_v2",
        signer: KeyPair | None = None,
    ) -> dict[str, Any]:
        """A signed notification; pass ``signer`` to forge one from another author."""
        payload = {"notification_type": notification_type, "notification": notification}
        content = self.encrypt(payload, client_pubkey, mode)
        return sign_event(
            signer or self.keys, KIND_NOTIFICATION[mode], [["p", client_pubkey]], content
        )


class FakeRelay:
    """A websocket relay on 127.0.0.1 with an ephemeral port; ``start()`` before use."""

    def __init__(self, wallet: FakeWallet | None = None, *, silent: bool = False) -> None:
        self.wallet = wallet
        self.silent = silent
        self._server: Server | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._subscriptions: dict[ServerConnection, dict[str, list[dict[str, Any]]]] = {}
        self.url = ""

    def __enter__(self) -> FakeRelay:
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def start(self) -> FakeRelay:
        self._server = serve(self._serve_connection, "127.0.0.1", 0)
        port = self._server.socket.getsockname()[1]
        self.url = f"ws://127.0.0.1:{port}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self.close_connections()
        if self._server is not None:
            self._server.shutdown()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def subscription_count(self, kind: int | None = None) -> int:
        """Live subscriptions, optionally only those asking for ``kind``."""
        with self._lock:
            return sum(
                1
                for subs in self._subscriptions.values()
                for filters in subs.values()
                if kind is None or any(kind in f.get("kinds", []) for f in filters)
            )

    def close_connections(self) -> None:
        with self._lock:
            connections = list(self._subscriptions)
        for connection in connections:
            connection.close()

    def push_notification(
        self,
        notification_type: str,
        notification: dict[str, Any],
        client_pubkey: str,
        *,
        mode: str = "nip44_v2",
        signer: KeyPair | None = None,
    ) -> dict[str, Any]:
        """Sign a notification and deliver it to every subscription for its kind."""
        assert self.wallet is not None
        event = self.wallet.notification_event(
            notification_type, notification, client_pubkey, mode=mode, signer=signer
        )
        self._broadcast(event)
        return event

    # -- server side ------------------------------------------------------------

    def _serve_connection(self, connection: ServerConnection) -> None:
        with self._lock:
            self._subscriptions[connection] = {}
        try:
            for raw in connection:
                if self.silent:
                    continue
                frame = json.loads(raw)
                if frame[0] == "REQ":
                    self._handle_req(connection, str(frame[1]), list(frame[2:]))
                elif frame[0] == "EVENT":
                    self._handle_event(connection, frame[1])
                elif frame[0] == "CLOSE":
                    with self._lock:
                        self._subscriptions[connection].pop(str(frame[1]), None)
        finally:
            with self._lock:
                self._subscriptions.pop(connection, None)

    def _handle_req(
        self, connection: ServerConnection, sub_id: str, filters: list[dict[str, Any]]
    ) -> None:
        with self._lock:
            self._subscriptions[connection][sub_id] = filters
        if self.wallet is not None and any(KIND_INFO in f.get("kinds", []) for f in filters):
            _send(connection, ["EVENT", sub_id, self.wallet.info_event()])
        _send(connection, ["EOSE", sub_id])

    def _handle_event(self, connection: ServerConnection, event: dict[str, Any]) -> None:
        _send(connection, ["OK", event["id"], True, ""])
        if self.wallet is not None and event.get("kind") == KIND_REQUEST:
            self._broadcast(self.wallet.answer(event))

    def _broadcast(self, event: dict[str, Any]) -> None:
        with self._lock:
            targets = [
                (connection, sub_id)
                for connection, subs in self._subscriptions.items()
                for sub_id, filters in subs.items()
                if any(_matches(f, event) for f in filters)
            ]
        for connection, sub_id in targets:
            _send(connection, ["EVENT", sub_id, event])


def _matches(filter_: dict[str, Any], event: dict[str, Any]) -> bool:
    if event["kind"] not in filter_.get("kinds", [event["kind"]]):
        return False
    for key, wanted in filter_.items():
        if key.startswith("#") and tag_value(event, key[1:]) not in wanted:
            return False
    return True


def _send(connection: ServerConnection, frame: list[Any]) -> None:
    try:
        connection.send(json.dumps(frame))
    except Exception:  # the client already left
        pass
