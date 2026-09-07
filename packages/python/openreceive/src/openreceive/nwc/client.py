"""The receive-only NWC client contract every engine component speaks.

Requests and replies are OpenReceive-shaped string-keyed dicts (`amount_msats`,
`payment_hash`, `transaction_state`, ...), never raw NIP-47 — the client maps
to the wire and normalizes back. `openreceive.nwc.receive_client.NwcReceiveClient`
is the production implementation over the in-repo transport;
`openreceive.testing.FakeWallet` is the in-process fake. A host may plug any
object with these four methods (an adapter over nostr-sdk, for example).
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any, Protocol, runtime_checkable

NotificationHandler = Callable[[dict[str, Any]], None]


@runtime_checkable
class ReceiveNwcClient(Protocol):
    def preflight(self) -> dict[str, Any]:
        """The wallet's kind 13194 info (`methods`, `encryption`, ...), as
        `openreceive.nwc.info.summarize` reads it."""

    def make_invoice(self, params: dict[str, Any]) -> dict[str, Any]:
        """{amount_msats, expiry?, description?, description_hash?, metadata?}
        → {invoice, payment_hash, amount_msats, created_at?, expires_at?}."""

    def list_transactions(self, params: dict[str, Any]) -> dict[str, Any]:
        """{type?, from?, until?, limit?, offset?, unpaid?} →
        {transactions: [normalized rows], skipped_rows?}."""

    def subscribe_notifications(
        self, handler: NotificationHandler, *, stop: threading.Event
    ) -> None:
        """Blocking NWC-02 subscription: `handler` receives
        {notification_type, notification} until `stop` is set. Raises when the
        socket closes so the worker can back off and resubscribe."""
