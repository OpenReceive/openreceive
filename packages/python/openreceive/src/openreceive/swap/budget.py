"""A disposable per-process request guard for the provider API; the provider
remains the global rate-limit authority and its 429 always wins. The guard is
sized by who the provider is: the same wire contract is served at very
different rates. Twin of Ruby `Swap::SwapProviderWeightBudget` (JS
weight-budget.ts)."""

from __future__ import annotations

import math
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

WINDOW_SECONDS = 60
SOFT_CAP = 200
CREATE_GATE = 150
CREATE_WEIGHT = 50
DEFAULT_WEIGHT = 1
BACKOFF_SECONDS = 60


@dataclass(frozen=True)
class SwapProviderLimits:
    """What one provider allows an API key per window, as far as the guard
    needs to know it."""

    # Whose published limits these are.
    profile: str
    # Weight every call in one window may add up to.
    soft_cap: int
    # Weight a create may bring the window up to.
    create_gate: int
    create_weight: int
    default_weight: int
    # Creates per window, for a provider that counts them on their own.
    create_limit: int | None
    # Stand-off after a 429 that names no wait.
    backoff_seconds: int
    # Shortest and longest stand-off a 429's own wait is honored for.
    min_backoff_seconds: int
    max_backoff_seconds: int
    # True when the provider counts new swaps apart from its other calls, so a
    # 429 answering a create stops creates only. Status and refund calls for
    # swaps that already exist keep working.
    create_backoff_only: bool


# FixedFloat: 250 weight a minute per key, a create costs 50, and going over
# blocks the key for longer each time. The guard stops well short: three
# creates a minute, 200 weight in all. Also the default for a provider this
# library does not know, because it is the stricter of the two.
FIXEDFLOAT_LIMITS = SwapProviderLimits(
    profile="fixedfloat",
    soft_cap=SOFT_CAP,
    create_gate=CREATE_GATE,
    create_weight=CREATE_WEIGHT,
    default_weight=DEFAULT_WEIGHT,
    create_limit=None,
    backoff_seconds=BACKOFF_SECONDS,
    min_backoff_seconds=BACKOFF_SECONDS,
    max_backoff_seconds=3_600,
    create_backoff_only=False,
)

# Lightning Swap: per account, 30 new swaps and 400 API calls a minute once
# the account has completed a swap, every call counting as one. It refuses
# with a 429 that says how long to wait and never blocks a key for going over,
# so the guard sits at the limit itself. An account on lower limits (one that
# has not completed a swap yet) is held to them by the provider's own 429,
# which this guard then obeys.
LIGHTNING_SWAP_LIMITS = SwapProviderLimits(
    profile="lightning-swap",
    soft_cap=400,
    create_gate=400,
    create_weight=1,
    default_weight=1,
    create_limit=30,
    backoff_seconds=60,
    min_backoff_seconds=1,
    max_backoff_seconds=300,
    create_backoff_only=True,
)

LIGHTNING_SWAP_HOST = "lightning-swap.com"


def limits_for_base_url(base_url: object) -> SwapProviderLimits:
    """The limits to guard a provider API with, chosen by its HTTPS host:
    Lightning Swap's own host or a subdomain of it, otherwise (an unknown
    host, a look-alike, a value that is not a URL) the FixedFloat limits."""
    try:
        parts = urlsplit(str(base_url))
        hostname = (parts.hostname or "").lower()
        _ = parts.port  # Raises on a port that is not one: the value is not a URL.
    except ValueError:
        return FIXEDFLOAT_LIMITS
    if hostname == LIGHTNING_SWAP_HOST or hostname.endswith(f".{LIGHTNING_SWAP_HOST}"):
        return LIGHTNING_SWAP_LIMITS
    return FIXEDFLOAT_LIMITS


class WeightBudgetError(RuntimeError):
    """Raised when a reservation would exceed the budget. `weight_budget` is
    the marker quote classification maps to provider_rate_limited."""

    weight_budget = True

    def __init__(self, message: str, denial: dict[str, Any]) -> None:
        super().__init__(message)
        self.denial = denial


def weight_budget_denial(error: BaseException) -> dict[str, Any] | None:
    """The denial a weight-budget error carries, for the log line that reports
    it; None for any other error."""
    if getattr(error, "weight_budget", False) is not True:
        return None
    denial = getattr(error, "denial", None)
    return denial if isinstance(denial, dict) else None


class SwapProviderWeightBudget:
    def __init__(
        self,
        provider_id: str,
        clock: Callable[[], int],
        limits: SwapProviderLimits | None = None,
    ) -> None:
        self._provider_id = provider_id
        self._clock = clock
        self._limits = FIXEDFLOAT_LIMITS if limits is None else limits
        self._window_start = clock()
        self._used = 0
        self._creates = 0
        self._backoff_until: int | None = None
        self._create_backoff_until: int | None = None
        self._lock = threading.Lock()

    @property
    def limits(self) -> SwapProviderLimits:
        return self._limits

    def weight_for_path(self, path: str) -> int:
        return self._limits.create_weight if path == "create" else self._limits.default_weight

    def assert_available(self, path: str) -> None:
        """Raise the same denial `reserve` would, without using any budget.
        Lets a caller refuse a new swap before it does any other work for it."""
        with self._lock:
            self._check(path)

    def reserve(self, path: str) -> None:
        with self._lock:
            self._used += self._check(path)
            if path == "create":
                self._creates += 1

    def mark_rate_limited(
        self, *, path: str | None = None, retry_after_seconds: float | None = None
    ) -> None:
        """The provider answered 429 on `path`; `retry_after_seconds` is its own
        wait, None when it named none. A later, shorter 429 never shortens a
        stand-off already running."""
        with self._lock:
            until = self._clock() + self._backoff_seconds(retry_after_seconds)
            if self._limits.create_backoff_only and path == "create":
                self._create_backoff_until = max(self._create_backoff_until or 0, until)
                return
            self._backoff_until = max(self._backoff_until or 0, until)
            # The provider's own window is spent until then and fresh after it,
            # so this guard's window restarts when the stand-off ends. Keeping
            # the old count would go on refusing calls the provider has started
            # accepting.
            self._window_start = self._backoff_until
            self._used = 0
            self._creates = 0

    def _check(self, path: str) -> int:
        """Deny `path` or return what reserving it costs. Under the lock."""
        self._roll_window()
        now = self._clock()
        cost = self.weight_for_path(path)
        gate = self._limits.create_gate if path == "create" else self._limits.soft_cap
        backoff_until = self._active_backoff(path, now)
        if backoff_until is not None:
            self._deny(
                path,
                "backoff",
                cost,
                gate,
                f"Swap provider API is in backoff until {backoff_until}.",
                backoff_until,
            )
        if self._used + cost > gate:
            self._deny(
                path,
                "exhausted",
                cost,
                gate,
                f"Swap provider API weight budget exhausted ({self._used}+{cost} > {gate}).",
            )
        create_limit = self._limits.create_limit
        if path == "create" and create_limit is not None and self._creates + 1 > create_limit:
            self._deny(
                path,
                "exhausted",
                cost,
                gate,
                f"Swap provider create budget exhausted ({self._creates}+1 > {create_limit}).",
            )
        return cost

    def _backoff_seconds(self, retry_after_seconds: object) -> int:
        limits = self._limits
        if (
            isinstance(retry_after_seconds, bool)
            or not isinstance(retry_after_seconds, (int, float))
            or (isinstance(retry_after_seconds, float) and not math.isfinite(retry_after_seconds))
            or retry_after_seconds <= 0
        ):
            return limits.backoff_seconds
        return min(
            max(math.ceil(retry_after_seconds), limits.min_backoff_seconds),
            limits.max_backoff_seconds,
        )

    def _active_backoff(self, path: str, now: int) -> int | None:
        if self._backoff_until is not None and self._backoff_until > now:
            return self._backoff_until
        if (
            path == "create"
            and self._create_backoff_until is not None
            and self._create_backoff_until > now
        ):
            return self._create_backoff_until
        return None

    def _roll_window(self) -> None:
        # The weight window rolls; the 429 backoff does NOT ride along with it
        # and expires on its own clock, checked in _check.
        now = self._clock()
        if now - self._window_start < WINDOW_SECONDS:
            return
        self._window_start = now
        self._used = 0
        self._creates = 0

    def _deny(
        self,
        path: str,
        reason: str,
        cost: int,
        gate: int,
        message: str,
        backoff_until: int | None = None,
    ) -> None:
        denial: dict[str, Any] = {
            "provider": self._provider_id,
            "path": path,
            "reason": reason,
            "message": message,
            "used": self._used,
            "cost": cost,
            "gate": gate,
            "window_start": self._window_start,
        }
        until = self._backoff_until if backoff_until is None else backoff_until
        if until is not None:
            denial["backoff_until"] = until
        if self._limits.create_limit is not None:
            denial["creates"] = self._creates
            denial["create_limit"] = self._limits.create_limit
        raise WeightBudgetError(message, denial)
