"""NIP-47 over a relay: info lookup, one request/response, notification stream."""

from __future__ import annotations

import json
import secrets
import threading
import time
from collections.abc import Callable
from typing import Any

from openreceive._generated.tables import NWC_ENCRYPTION_MODES

from . import nip04, nip44
from .errors import TransportError
from .nip01 import KeyPair, sign_event, tag_value, verify_event
from .relay import RelaySession

KIND_INFO = 13194
KIND_REQUEST = 23194
KIND_RESPONSE = 23195
KIND_NOTIFICATION_NIP04 = 23196
KIND_NOTIFICATION_NIP44 = 23197

NIP44 = "nip44_v2"
NIP04 = "nip04"
_NOTIFICATION_KIND = {NIP44: KIND_NOTIFICATION_NIP44, NIP04: KIND_NOTIFICATION_NIP04}
_STOP_POLL_SECONDS = 0.25

NotificationHandler = Callable[[dict[str, Any]], None]


class NwcTransport:
    """Receive-only NWC transport for one connection (wallet pubkey, relays, secret).

    Every RPC is one short websocket session: connect, REQ for the reply,
    publish the request, wait for the reply e-tagged to our event id, close.
    Relays are tried in order; a relay that refuses the connection is skipped,
    any other failure is raised as ``TransportError``.
    """

    def __init__(
        self,
        wallet_pubkey: str,
        relays: list[str],
        secret: str,
        *,
        deadline_seconds: float = 10.0,
        encryption: str | None = None,
    ) -> None:
        if not relays:
            raise ValueError("at least one relay is required")
        self.wallet_pubkey = wallet_pubkey
        self.relays = list(relays)
        self.deadline_seconds = deadline_seconds
        self._keys = KeyPair(secret)
        self._shared_x = self._keys.shared_x(wallet_pubkey)
        self._conversation_key = nip44.conversation_key(self._shared_x)
        self._encryption = encryption
        self._info: dict[str, Any] | None = None
        self._subscription: RelaySession | None = None
        self._lock = threading.Lock()

    @property
    def pubkey(self) -> str:
        """The connection's own x-only pubkey (the ``p`` tag wallets reply to)."""
        return self._keys.pubkey

    # -- info ---------------------------------------------------------------

    def info(self) -> dict[str, Any]:
        """The wallet's kind 13194 info event, summarized; cached per instance."""
        if self._info is None:
            deadline_at = time.monotonic() + self.deadline_seconds
            self._info = self._with_relay(deadline_at, self._fetch_info)
        return self._info

    def _fetch_info(self, session: RelaySession, deadline_at: float) -> dict[str, Any]:
        sub_id = _sub_id("info")
        session.subscribe(
            sub_id, {"kinds": [KIND_INFO], "authors": [self.wallet_pubkey], "limit": 1}
        )
        while True:
            frame = session.read_until(deadline_at)
            if frame[0] == "EVENT" and frame[1] == sub_id:
                event = frame[2]
                if self._authentic(event) and event.get("kind") == KIND_INFO:
                    return _summarize_info(event)
            elif frame[0] in ("EOSE", "CLOSED") and frame[1] == sub_id:
                raise TransportError(
                    "protocol", f"{session.url} holds no info event for the wallet pubkey"
                )

    def encryption(self) -> str:
        """The negotiated mode: the first kernel-preferred mode the wallet advertises."""
        if self._encryption is None:
            advertised = self.info()["encryption"] or [NIP04]
            chosen = next((mode for mode in NWC_ENCRYPTION_MODES if mode in advertised), None)
            if chosen is None:
                raise TransportError(
                    "protocol", f"wallet advertises no supported encryption: {advertised}"
                )
            self._encryption = chosen
        return self._encryption

    # -- request/response -----------------------------------------------------

    def request(
        self, method: str, params: dict[str, Any], *, deadline_seconds: float | None = None
    ) -> dict[str, Any]:
        """One NIP-47 request; returns the decrypted reply dict verbatim."""
        budget = self.deadline_seconds if deadline_seconds is None else deadline_seconds
        deadline_at = time.monotonic() + budget
        mode = self.encryption()
        tags = [["p", self.wallet_pubkey]]
        if mode == NIP44:
            tags.append(["encryption", NIP44])
        content = self._encrypt(json.dumps({"method": method, "params": params}), mode)
        event = sign_event(self._keys, KIND_REQUEST, tags, content)

        def exchange(session: RelaySession, deadline_at: float) -> dict[str, Any]:
            sub_id = _sub_id("rsp")
            session.subscribe(
                sub_id,
                {
                    "kinds": [KIND_RESPONSE],
                    "authors": [self.wallet_pubkey],
                    "#e": [event["id"]],
                    "#p": [self.pubkey],
                },
            )
            session.publish(event)
            while True:
                frame = session.read_until(deadline_at)
                if frame[0] == "EVENT" and frame[1] == sub_id:
                    reply = frame[2]
                    if (
                        self._authentic(reply)
                        and reply.get("kind") == KIND_RESPONSE
                        and tag_value(reply, "e") == event["id"]
                    ):
                        return self._decrypt_json(reply, tag_value(reply, "encryption") or mode)
                elif frame[0] == "OK" and frame[1] == event["id"] and frame[2] is False:
                    raise TransportError("protocol", f"relay rejected the request: {frame[3:]}")
                elif frame[0] == "CLOSED" and frame[1] == sub_id:
                    raise TransportError("protocol", f"relay closed the subscription: {frame[2:]}")

        reply: dict[str, Any] = self._with_relay(deadline_at, exchange)
        return reply

    # -- notifications ----------------------------------------------------------

    def subscribe_notifications(
        self, handler: NotificationHandler, *, stop: threading.Event
    ) -> None:
        """Stream decrypted notifications to ``handler`` until ``stop`` is set.

        Only the notification kind matching the negotiated encryption is
        requested (wallets that support NIP-44 publish both kinds for one
        notification). Every event must be signed by the wallet pubkey; the
        rest is ignored. Raises ``TransportError("closed")`` when the socket
        ends so the caller can back off and resubscribe.
        """
        mode = self.encryption()
        kind = _NOTIFICATION_KIND[mode]
        deadline_at = time.monotonic() + self.deadline_seconds
        session = self._with_relay(deadline_at, lambda s, _: s)
        with self._lock:
            self._subscription = session
        try:
            session.subscribe(
                _sub_id("ntf"),
                {"kinds": [kind], "authors": [self.wallet_pubkey], "#p": [self.pubkey]},
            )
            while not stop.is_set():
                frame = session.read(_STOP_POLL_SECONDS)
                if frame is None or frame[0] != "EVENT":
                    continue
                event = frame[2]
                if not self._authentic(event) or event.get("kind") != kind:
                    continue
                try:
                    payload = self._decrypt_json(event, mode)
                except TransportError:
                    continue
                try:
                    handler(
                        {
                            "notification_type": payload.get("notification_type"),
                            "notification": payload.get("notification") or {},
                        }
                    )
                except Exception:  # a failing handler never ends the stream
                    pass
        finally:
            with self._lock:
                self._subscription = None
            session.close()

    def close(self) -> None:
        """End a live notification subscription, if any (per-call sessions self-close)."""
        with self._lock:
            session = self._subscription
        if session is not None:
            session.close()

    # -- internals ----------------------------------------------------------------

    def _with_relay(
        self,
        deadline_at: float,
        action: Callable[[RelaySession, float], Any],
    ) -> Any:
        last: TransportError | None = None
        for url in self.relays:
            try:
                session = RelaySession.open(url, deadline_at)
            except TransportError as exc:
                if exc.kind != "connect":
                    raise
                last = exc
                continue
            keep_open = False
            try:
                result = action(session, deadline_at)
                keep_open = result is session
                return result
            finally:
                if not keep_open:
                    session.close()
        assert last is not None
        raise last

    def _authentic(self, event: Any) -> bool:
        return (
            isinstance(event, dict)
            and event.get("pubkey") == self.wallet_pubkey
            and verify_event(event)
        )

    def _encrypt(self, plaintext: str, mode: str) -> str:
        if mode == NIP44:
            return nip44.encrypt(plaintext, self._conversation_key)
        return nip04.encrypt(plaintext, self._shared_x)

    def _decrypt_json(self, event: dict[str, Any], mode: str) -> dict[str, Any]:
        try:
            if mode == NIP44:
                plaintext = nip44.decrypt(event["content"], self._conversation_key)
            else:
                plaintext = nip04.decrypt(event["content"], self._shared_x)
            payload = json.loads(plaintext)
        except (ValueError, KeyError, TypeError) as exc:
            raise TransportError("decrypt", f"could not decrypt event {event.get('id')}") from exc
        if not isinstance(payload, dict):
            raise TransportError("protocol", "wallet payload is not a JSON object")
        return payload


def _summarize_info(event: dict[str, Any]) -> dict[str, Any]:
    content = str(event.get("content", ""))
    return {
        "methods": content.split(),
        "notifications": (tag_value(event, "notifications") or "").split(),
        "encryption": (tag_value(event, "encryption") or "").split(),
        "raw_content": content,
    }


def _sub_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4)}"
