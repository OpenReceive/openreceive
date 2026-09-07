"""An in-memory swap provider — a PORT of the JS testkit `TestkitSwapProvider`:
same deposit addresses, same `testkit-swap-N` order ids, same "1.05" pay
amount (docs/internal/testkit-contract.md). Speaks the FixedFloat provider's
surface: `name`, `supported_pay_in_assets`, `pay_in_asset_catalog`,
`invoice_expiry_seconds`, `quote`, `create_swap`, `get_status`, `request_refund`.
The runtime attachments the real provider takes are all optional."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

from openreceive.swap import assets
from openreceive.values import stringify

# One address per NETWORK, not per asset: USDT_TRON and a second Tron token
# share a Tron address, which is exactly what the deposit panel's warning is about.
NETWORK_DEPOSIT_ADDRESS = {
    "TRX": "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
    "SOL": "So11111111111111111111111111111111111111112",
    "ETH": "0x1111111111111111111111111111111111111111",
}
PAY_AMOUNT = "1.05"
# The shadow invoice must outlive the provider order; the service takes this as a FLOOR.
INVOICE_EXPIRY_SECONDS = 1_800
DEPOSIT_EXPIRY_SECONDS = 900
PROGRESS_ORDER = (
    "creating_provider_order",
    "awaiting_deposit",
    "confirming",
    "exchanging",
    "paying_invoice",
    "completed",
)

Selector = str | dict[str, Any]


class FakeSwapProvider:
    def __init__(self, *, name: str = "fixedfloat", clock: Callable[[], int] | None = None) -> None:
        self.name = name
        self._clock: Callable[[], int] = clock or (lambda: int(time.time()))
        self._orders: dict[str, dict[str, Any]] = {}
        # An asset scripted BEFORE any attempt exists arms the next attempt for it.
        self._pending: dict[str, dict[str, Any]] = {}
        self._pay_amounts: dict[str, str] = {}
        self._next_create_error: BaseException | None = None
        self._create_calls = 0
        self._quote_calls = 0
        self._status_calls = 0
        self._refund_calls: list[dict[str, Any]] = []
        self._lock = threading.RLock()

    # --------------------------------------------------- provider contract

    def supported_pay_in_assets(self) -> list[str]:
        return list(assets.PAY_IN_ASSETS)

    def pay_in_asset_catalog(self) -> list[dict[str, Any]]:
        return [
            {
                "pay_asset": asset,
                "available": True,
                "minimum_pay_amount": "1",
                "maximum_pay_amount": "5000",
            }
            for asset in assets.PAY_IN_ASSETS
        ]

    def invoice_expiry_seconds(self, pay_in_asset: str | None = None) -> int:
        return INVOICE_EXPIRY_SECONDS

    def quote(self, *, pay_in_asset: str, invoice_amount_msats: int) -> dict[str, Any]:
        with self._lock:
            self._quote_calls += 1
            pay_amount = self._pay_amounts.get(pay_in_asset, PAY_AMOUNT)
        return {
            "pay_amount": pay_amount,
            "pay_asset": pay_in_asset,
            "available": True,
            "provider": self.name,
            "minimum_pay_amount": "1",
            "maximum_pay_amount": "5000",
        }

    def create_swap(
        self, *, pay_in_asset: str, bolt11: str, invoice_amount_msats: int
    ) -> dict[str, Any]:
        with self._lock:
            if self._next_create_error is not None:
                error, self._next_create_error = self._next_create_error, None
                raise error
            self._create_calls += 1
            provider_order_id = f"testkit-swap-{self._create_calls}"
            order: dict[str, Any] = {
                "provider": self.name,
                "provider_order_id": provider_order_id,
                "provider_token": f"testkit-token-{self._create_calls}",
                "pay_in_asset": pay_in_asset,
                "deposit_address": NETWORK_DEPOSIT_ADDRESS[assets.info(pay_in_asset)["network"]],
                "deposit_amount": self._pay_amounts.get(pay_in_asset, PAY_AMOUNT),
                "expires_at": self._clock() + DEPOSIT_EXPIRY_SECONDS,
                "state": "awaiting_deposit",
            }
            armed = self._pending.pop(pay_in_asset, None)
            entry: dict[str, Any] = {
                "order": order,
                "steps": list(armed["steps"]) if armed else [],
                "next": 0,
                "attention_reason": armed.get("attention_reason") if armed else None,
            }
            if armed and armed.get("immediate"):
                entry["order"] = self._apply_state(
                    order, armed["steps"][0], armed.get("attention_reason")
                )
                entry["steps"] = []
            self._orders[provider_order_id] = entry
            return dict(entry["order"])

    def get_status(self, order: dict[str, Any]) -> dict[str, Any]:
        """One step per poll, then hold on the last state — the harness advances
        a swap by letting the page poll, which is how a payer experiences it."""
        stored_id = str(stringify(order)["provider_order_id"])
        with self._lock:
            self._status_calls += 1
            entry = self._orders.get(stored_id)
            if entry is None:
                return dict(order)
            if entry["next"] < len(entry["steps"]):
                state = entry["steps"][entry["next"]]
                entry["next"] += 1
                entry["order"] = self._apply_state(
                    entry["order"], state, entry.get("attention_reason")
                )
            return dict(entry["order"])

    def request_refund(self, order: dict[str, Any], refund_address: str) -> None:
        stored_id = str(stringify(order)["provider_order_id"])
        with self._lock:
            self._refund_calls.append(
                {"provider_order_id": stored_id, "refund_address": refund_address}
            )
            entry = self._orders.get(stored_id)
            if entry is not None:
                entry["order"] = self._apply_state(entry["order"], "refund_pending", None)

    # ------------------------------------------------------------- controls

    def script(
        self, selector: Selector, states: list[str], *, attention_reason: str | None = None
    ) -> None:
        """Queue states for the selected attempts; arm the asset so an attempt
        created later gets them too."""
        if not states:
            raise ValueError("swap script must include at least one state")
        with self._lock:
            for entry in self._match(selector):
                entry["steps"] = list(states)
                entry["next"] = 0
                entry["attention_reason"] = attention_reason
            asset = self._asset_of(selector)
            if asset:
                self._pending[asset] = {"steps": list(states), "attention_reason": attention_reason}

    def force(self, selector: Selector, state: str, *, attention_reason: str | None = None) -> None:
        """`refund_required` and `attention` land IMMEDIATELY rather than on the
        next poll: they are the states a test jumps to."""
        with self._lock:
            for entry in self._match(selector):
                entry["steps"] = []
                entry["next"] = 0
                entry["attention_reason"] = attention_reason
                entry["order"] = self._apply_state(entry["order"], state, attention_reason)
            asset = self._asset_of(selector)
            if asset:
                self._pending[asset] = {
                    "steps": [state],
                    "attention_reason": attention_reason,
                    "immediate": True,
                }

    def force_refund_required(self, selector: Selector) -> None:
        self.force(selector, "refund_required")

    def force_attention(
        self, selector: Selector, reason: str = "provider_reported_emergency"
    ) -> None:
        self.force(selector, "attention", attention_reason=reason)

    def force_create_error(self, error: BaseException | None = None) -> None:
        with self._lock:
            self._next_create_error = error or RuntimeError("testkit: swap provider create failed")

    def set_pay_amount(self, pay_in_asset: str, pay_amount: str) -> None:
        with self._lock:
            self._pay_amounts[pay_in_asset] = pay_amount

    def counters(self) -> dict[str, Any]:
        with self._lock:
            return {
                "create_calls": self._create_calls,
                "quote_calls": self._quote_calls,
                "status_calls": self._status_calls,
                "refund_calls": [dict(call) for call in self._refund_calls],
            }

    # ------------------------------------------------------------ internals

    @staticmethod
    def _asset_of(selector: Selector) -> str | None:
        if isinstance(selector, str):
            return selector
        value = stringify(selector).get("pay_in_asset")
        return str(value) if value else None

    def _match(self, selector: Selector) -> list[dict[str, Any]]:
        if isinstance(selector, str):
            selector = {"pay_in_asset": selector}
        data = stringify(selector)
        provider_order_id = data.get("provider_order_id")
        asset = data.get("pay_in_asset")
        matches: list[dict[str, Any]] = []
        for entry in self._orders.values():
            order = entry["order"]
            if provider_order_id and order["provider_order_id"] != provider_order_id:
                continue
            if asset and order["pay_in_asset"] != asset:
                continue
            matches.append(entry)
        return matches

    @staticmethod
    def _apply_state(
        order: dict[str, Any], state: str, attention_reason: str | None
    ) -> dict[str, Any]:
        next_order = {**order, "state": state}
        if state in PROGRESS_ORDER and PROGRESS_ORDER.index(state) >= PROGRESS_ORDER.index(
            "confirming"
        ):
            next_order["deposit_tx_id"] = "testkit-deposit-tx"
        if state == "completed":
            next_order["payout_tx_id"] = "testkit-payout-tx"
        if state == "refunded":
            next_order["refund_tx_id"] = "testkit-refund-tx"
        if state == "attention":
            next_order["attention"] = True
            if attention_reason is not None:
                next_order["attention_reason"] = attention_reason
        return next_order
