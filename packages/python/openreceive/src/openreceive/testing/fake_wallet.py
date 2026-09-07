"""An in-memory NWC wallet — a PORT of the JS testkit `TestkitReceiveClient`,
not a second invention (docs/internal/testkit-contract.md). The fixtures are
identical on purpose: payment hashes are the mint counter in 64 hex
characters, invoices are `lnbcopenreceive000001`, so one Playwright suite can
drive every stack and assert the same strings.

Speaks the engine's `ReceiveNwcClient` contract: dicts in, dicts out, string keys.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

from openreceive import money
from openreceive._generated.tables import NWC_METADATA_MAX_BYTES
from openreceive.nwc.client import NotificationHandler
from openreceive.nwc.requests import json_bytes
from openreceive.values import stringify, to_int

PREIMAGE = "1" * 64  # Never a real preimage; nothing verifies it.
WALLET_PUBKEY = "f" * 64
RELAY = "wss://relay.test.openreceive.local"
DEFAULT_EXPIRY_SECONDS = 600

Selector = str | dict[str, Any]


class FakeWallet:
    def __init__(
        self,
        *,
        clock: Callable[[], int] | None = None,
        default_expiry_seconds: int = DEFAULT_EXPIRY_SECONDS,
    ) -> None:
        # The real clock by default: a fixed low clock would put every invoice
        # past expiry plus grace and let a reconcile pass close attempts a test
        # still considers pending. Tests that need determinism inject a clock.
        self._clock: Callable[[], int] = clock or (lambda: int(time.time()))
        self._default_expiry = default_expiry_seconds
        self._counter = 0
        self._by_hash: dict[str, dict[str, Any]] = {}
        self._scripts: dict[str, list[Any]] = {}
        self._handlers: list[NotificationHandler] = []
        # Every mutation may cross a thread boundary: a control route settles an
        # invoice while a payments/check poll reads the store on another thread.
        self._lock = threading.RLock()

    # ------------------------------------------------------ client contract

    def preflight(self) -> dict[str, Any]:
        """Receive-only: advertising a spend method here would trip the
        service's own refusal, which is behaviour other suites test."""
        return {
            "wallet_pubkey": WALLET_PUBKEY,
            "relays": [RELAY],
            "methods": ["make_invoice", "list_transactions"],
            "encryption": ["nip04"],
        }

    def make_invoice(self, params: dict[str, Any]) -> dict[str, Any]:
        data = stringify(params)
        amount_msats = money.bounded_msats(data["amount_msats"])
        if "metadata" in data and json_bytes(data["metadata"]) > NWC_METADATA_MAX_BYTES:
            raise ValueError("metadata is too large")
        with self._lock:
            self._counter += 1
            created_at = self._clock()
            # The requested expiry is HONOURED exactly: the service rejects a
            # deviation over 60 s on the swap path.
            expires_at = created_at + to_int(data.get("expiry") or self._default_expiry)
            record: dict[str, Any] = {
                "type": "incoming",
                "invoice": f"lnbcopenreceive{self._counter:06d}",
                "payment_hash": format(self._counter, "064x"),
                "amount_msats": amount_msats,
                "created_at": created_at,
                "expires_at": expires_at,
                "transaction_state": "pending",
                "state": "pending",
            }
            self._by_hash[record["payment_hash"]] = record
            return {
                key: record[key]
                for key in ("invoice", "payment_hash", "amount_msats", "created_at", "expires_at")
            }

    def list_transactions(self, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Settlement is read from HISTORY exactly as the reconcile pass reads
        it: unpaid rows are excluded unless asked for, so a pending invoice is
        simply absent rather than present-and-unsettled."""
        data = stringify(params or {})
        if data.get("type") == "outgoing":
            return {"transactions": []}
        include_unpaid = data.get("unpaid") is True
        with self._lock:
            scripted = [self._next_scripted(record) for record in self._by_hash.values()]
        rows: list[dict[str, Any]] = [row for row in scripted if row is not None]
        if data.get("from") is not None:
            rows = [row for row in rows if row["created_at"] >= to_int(data["from"])]
        if data.get("until") is not None:
            rows = [row for row in rows if row["created_at"] <= to_int(data["until"])]
        rows = [row for row in rows if include_unpaid or row.get("transaction_state") == "settled"]
        # Newest first, ties broken by payment hash descending.
        rows.sort(key=lambda row: (row["created_at"], row["payment_hash"]), reverse=True)
        offset = to_int(data.get("offset") or 0)
        limit = len(rows) if data.get("limit") is None else to_int(data["limit"])
        return {"transactions": rows[offset : offset + limit]}

    def subscribe_notifications(
        self, handler: NotificationHandler, *, stop: threading.Event | None = None
    ) -> None:
        """Registers the handler. Blocks until `stop` is set when one is given
        (the worker's contract); returns at once otherwise (host tests)."""
        with self._lock:
            self._handlers.append(handler)
        if stop is not None:
            stop.wait()
            with self._lock:
                if handler in self._handlers:
                    self._handlers.remove(handler)

    def close(self) -> None:
        return None

    # ------------------------------------------------------------- controls

    def settle_invoice(
        self,
        selector: Selector,
        *,
        settled_at: int | None = None,
        preimage: str | None = None,
        notify: bool = False,
    ) -> dict[str, Any]:
        record = self._mutate(
            selector,
            {
                "transaction_state": "settled",
                "state": "settled",
                "settled_at": self._clock() if settled_at is None else settled_at,
                "preimage": preimage or PREIMAGE,
            },
        )
        if notify:
            self.emit_notification("payment_received", record)
        return record

    def expire_invoice(self, selector: Selector) -> dict[str, Any]:
        return self._mutate(selector, {"transaction_state": "expired", "state": "expired"})

    def fail_invoice(self, selector: Selector) -> dict[str, Any]:
        return self._mutate(selector, {"transaction_state": "failed", "state": "failed"})

    def script_transaction_sequence(self, selector: Selector, steps: list[Any]) -> None:
        """Each subsequent history read of the invoice yields the next step — a
        state change (str), a literal transaction (dict) or a raised error
        (an Exception instance) — then falls back to the stored state."""
        with self._lock:
            record = self._find(selector)
            self._scripts[record["payment_hash"]] = list(steps)

    def list_invoices(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(record) for record in self._by_hash.values()]

    def emit_notification(self, notification_type: str, payload: dict[str, Any]) -> None:
        """Delivers only payment_received; a raising handler never breaks the subscription."""
        if notification_type != "payment_received":
            return
        with self._lock:
            handlers = list(self._handlers)
        for handler in handlers:
            try:
                handler({"notification_type": notification_type, "notification": dict(payload)})
            except Exception:
                pass

    # ------------------------------------------------------------ internals

    def _find(self, selector: Selector) -> dict[str, Any]:
        if isinstance(selector, str):
            selector = {"payment_hash": selector}
        data = stringify(selector)
        if data.get("payment_hash"):
            record = self._by_hash.get(str(data["payment_hash"]).lower())
        elif data.get("invoice"):
            record = next(
                (row for row in self._by_hash.values() if row["invoice"] == data["invoice"]), None
            )
        else:
            record = None
        if record is None:
            raise KeyError("testkit invoice not found")
        return record

    def _mutate(self, selector: Selector, changes: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            record = self._find(selector)
            record.update(changes)
            return dict(record)

    def _next_scripted(self, record: dict[str, Any]) -> dict[str, Any] | None:
        steps = self._scripts.get(record["payment_hash"])
        if not steps:
            return dict(record)
        step = steps.pop(0)
        if isinstance(step, BaseException):
            raise step
        if isinstance(step, dict):
            return {**record, **step}
        if isinstance(step, str):
            record["transaction_state"] = step
            record["state"] = step
            if step == "settled":
                record.setdefault("settled_at", self._clock())
                record.setdefault("preimage", PREIMAGE)
            return dict(record)
        return dict(record)
