"""One synchronous websocket session with a Nostr relay, bounded by a deadline."""

from __future__ import annotations

import json
import time
from typing import Any

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import ClientConnection, connect

from .errors import TransportError

Frame = list[Any]


class RelaySession:
    """Publish events and read frames from one relay; every read is deadline-bounded.

    Frames are the relay's JSON arrays (``["EVENT", sub_id, event]``,
    ``["EOSE", sub_id]``, ``["OK", id, ok, msg]``, ``["CLOSED", ...]``,
    ``["NOTICE", ...]``) parsed but not interpreted — the caller decides which
    ones matter.
    """

    def __init__(self, url: str, connection: ClientConnection) -> None:
        self.url = url
        self._connection = connection

    @classmethod
    def open(cls, url: str, deadline_at: float) -> RelaySession:
        remaining = deadline_at - time.monotonic()
        if remaining <= 0:
            raise TransportError("deadline", f"deadline passed before connecting to {url}")
        try:
            connection = connect(url, open_timeout=remaining, max_size=2**22)
        except TimeoutError as exc:
            raise TransportError("deadline", f"connecting to {url} timed out") from exc
        except Exception as exc:  # OSError, InvalidURI, InvalidHandshake, ...
            raise TransportError("connect", f"could not connect to {url}: {exc}") from exc
        return cls(url, connection)

    def send(self, frame: Frame) -> None:
        try:
            self._connection.send(json.dumps(frame, separators=(",", ":")))
        except ConnectionClosed as exc:
            raise TransportError("closed", f"{self.url} closed the connection") from exc

    def publish(self, event: dict[str, Any]) -> None:
        self.send(["EVENT", event])

    def subscribe(self, sub_id: str, *filters: dict[str, Any]) -> None:
        self.send(["REQ", sub_id, *filters])

    def read(self, timeout: float) -> Frame | None:
        """The next parsed frame, or None when ``timeout`` seconds pass without one.

        Non-array or non-JSON frames are skipped. Raises ``TransportError("closed")``
        when the socket ends.
        """
        deadline_at = time.monotonic() + timeout
        while True:
            remaining = deadline_at - time.monotonic()
            if remaining <= 0:
                return None
            try:
                raw = self._connection.recv(timeout=remaining)
            except TimeoutError:
                return None
            except ConnectionClosed as exc:
                raise TransportError("closed", f"{self.url} closed the connection") from exc
            try:
                frame = json.loads(raw)
            except ValueError:
                continue
            if isinstance(frame, list) and frame:
                return frame

    def read_until(self, deadline_at: float) -> Frame:
        """The next frame before ``deadline_at`` (monotonic), else ``TransportError("deadline")``."""
        frame = self.read(max(deadline_at - time.monotonic(), 0.0))
        if frame is None:
            raise TransportError("deadline", f"{self.url} did not answer before the deadline")
        return frame

    def close(self) -> None:
        try:
            self._connection.close()
        except Exception:  # already closed, or the socket is gone
            pass
