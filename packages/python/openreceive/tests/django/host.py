"""The test host: the three hooks over the engine's fakes, with the pieces a
test needs to reach (the wallet, the provider, the clock, the settlements)
kept on one `State` object the conftest resets per test."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from django.db import transaction
from django.http import HttpRequest

from openreceive.server import HookContext, Service
from openreceive.storage import PaymentSettlement
from openreceive.testing import FakeSwapProvider, FakeWallet, StaticPriceProvider

REFERENCE = "order-42"
SATS_REFERENCE = "order-sats"


@dataclass
class State:
    now: int = 1_700_000_000
    wallet: FakeWallet = field(default_factory=FakeWallet)
    provider: FakeSwapProvider = field(default_factory=FakeSwapProvider)
    paid: list[PaymentSettlement] = field(default_factory=list)
    after: list[PaymentSettlement] = field(default_factory=list)
    authorize_requests: list[Any] = field(default_factory=list)
    in_atomic_block: list[bool] = field(default_factory=list)


state = State()


def reset() -> State:
    global state
    state = State()
    state.wallet = FakeWallet(clock=lambda: state.now)
    state.provider = FakeSwapProvider(clock=lambda: state.now)
    return state


def build_service(_env: Mapping[str, str]) -> Service:
    return Service(
        state.wallet,
        price_provider=StaticPriceProvider(),
        swap_providers=[state.provider],
        clock=lambda: state.now,
    )


class Host:
    def amount_for(self, reference: str) -> dict[str, Any] | None:
        if reference == REFERENCE:
            return {"currency": "USD", "value": "1.00", "description": "one button"}
        if reference == SATS_REFERENCE:
            return {"sats": 1000}
        return None

    def authorize(self, context: HookContext) -> bool:
        request = context.request
        state.authorize_requests.append(request)
        if not isinstance(request, HttpRequest):
            return False
        user = request.session.get("user") or request.headers.get("X-Test-User")
        return user == "alice"

    def on_paid(self, settlement: PaymentSettlement) -> None:
        state.in_atomic_block.append(transaction.get_connection().in_atomic_block)
        state.paid.append(settlement)

    def after_paid(self, settlement: PaymentSettlement) -> None:
        state.after.append(settlement)
