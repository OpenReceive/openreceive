"""A disposable per-process request guard for the provider API; the provider
remains the global rate-limit authority and its 429 always wins. Only
FixedFloat's own host is counted locally: every other provider limits its own
accounts and says so with a 429, which the guard obeys. Twin of Ruby
`Swap::SwapProviderWeightBudget` (JS weight-budget.ts)."""

from __future__ import annotations

import math
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

WINDOW_SECONDS = 60
BACKOFF_SECONDS = 60


@dataclass(frozen=True)
class LocalBudget:
    """The per-window count the guard keeps for a provider that needs one.
    Every call adds its weight to the window; a create may bring the window up
    to the whole soft cap, and the calls that are not creates (status, refund,
    catalog) may use only `non_create_cap` of it between them, so open swap
    screens polling their status never starve new swaps."""

    # Weight every call in one window may add up to.
    soft_cap: int
    # Weight the calls that are not creates may use between them in one window.
    non_create_cap: int
    create_weight: int
    default_weight: int


@dataclass(frozen=True)
class SwapProviderLimits:
    """How the request guard treats one provider."""

    # "fixedfloat" for FixedFloat's own host; "provider-only" for every other.
    profile: str
    # The per-window count, or None when the guard keeps none and only obeys
    # the provider's 429.
    local_budget: LocalBudget | None
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
# blocks the key for longer each time. So the guard counts: 200 weight a
# minute in all, of which the calls that are not creates may use 50. At least
# three creates a minute always fit, four when nothing else ran. A 429 stops
# every call for at least a minute.
FIXEDFLOAT_LIMITS = SwapProviderLimits(
    profile="fixedfloat",
    local_budget=LocalBudget(soft_cap=200, non_create_cap=50, create_weight=50, default_weight=1),
    backoff_seconds=BACKOFF_SECONDS,
    min_backoff_seconds=BACKOFF_SECONDS,
    max_backoff_seconds=3_600,
    create_backoff_only=False,
)

# Every other provider (Lightning Swap, one this library does not know, a test
# fake): no local count. The provider limits its own accounts and says so with
# a 429; a count of this library's own could only refuse payers the provider
# would have accepted. A 429 that answered a create stops creates only, for the
# wait it names (1 to 300 seconds; a minute when it names none). Lightning Swap
# answers this way: it counts new swaps apart from its other calls, per
# account, and names the wait in Retry-After.
PROVIDER_ONLY_LIMITS = SwapProviderLimits(
    profile="provider-only",
    local_budget=None,
    backoff_seconds=60,
    min_backoff_seconds=1,
    max_backoff_seconds=300,
    create_backoff_only=True,
)

FIXEDFLOAT_HOST = "ff.io"


def limits_for_base_url(base_url: object) -> SwapProviderLimits:
    """The limits to guard a provider API with, chosen by its HTTPS host:
    FixedFloat's own host or a subdomain of it is counted locally; every other
    host (Lightning Swap, an unknown host, a look-alike, a value that is not a
    URL) only obeys the provider's 429."""
    try:
        parts = urlsplit(str(base_url))
        hostname = (parts.hostname or "").lower()
        _ = parts.port  # Raises on a port that is not one: the value is not a URL.
    except ValueError:
        return PROVIDER_ONLY_LIMITS
    if hostname == FIXEDFLOAT_HOST or hostname.endswith(f".{FIXEDFLOAT_HOST}"):
        return FIXEDFLOAT_LIMITS
    return PROVIDER_ONLY_LIMITS


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
        self._limits = PROVIDER_ONLY_LIMITS if limits is None else limits
        self._window_start = clock()
        self._used = 0
        self._non_create_used = 0
        self._backoff_until: int | None = None
        self._create_backoff_until: int | None = None
        self._lock = threading.Lock()

    @property
    def limits(self) -> SwapProviderLimits:
        return self._limits

    def assert_available(self, path: str) -> None:
        """Raise the same denial `reserve` would, without using any budget.
        Lets a caller refuse a new swap before it does any other work for it."""
        with self._lock:
            self._check(path)

    def reserve(self, path: str) -> None:
        with self._lock:
            cost = self._check(path)
            if cost is None:
                return
            self._used += cost
            if path != "create":
                self._non_create_used += cost

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
            self._non_create_used = 0

    def _check(self, path: str) -> int | None:
        """Deny `path` or return what reserving it costs (None: nothing is
        counted). Under the lock."""
        self._roll_window()
        budget = self._limits.local_budget
        backoff_until = self._active_backoff(path, self._clock())
        if backoff_until is not None:
            self._deny(
                path,
                "backoff",
                f"Swap provider API is in backoff until {backoff_until}.",
                None if budget is None else self._weigh(path, budget),
                backoff_until,
            )
        if budget is None:
            return None
        cost = budget.create_weight if path == "create" else budget.default_weight
        if self._used + cost > budget.soft_cap:
            self._deny(
                path,
                "exhausted",
                f"Swap provider API weight budget exhausted ({self._used}+{cost} > {budget.soft_cap}).",
                (self._used, cost, budget.soft_cap),
            )
        if path != "create" and self._non_create_used + cost > budget.non_create_cap:
            self._deny(
                path,
                "exhausted",
                "Swap provider API weight budget for calls other than creates exhausted "
                f"({self._non_create_used}+{cost} > {budget.non_create_cap}).",
                (self._non_create_used, cost, budget.non_create_cap),
            )
        return cost

    def _weigh(self, path: str, budget: LocalBudget) -> tuple[int, int, int]:
        """(used, cost, gate) for the cap `path` is counted against."""
        if path == "create":
            return (self._used, budget.create_weight, budget.soft_cap)
        return (self._non_create_used, budget.default_weight, budget.non_create_cap)

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
        self._non_create_used = 0

    def _deny(
        self,
        path: str,
        reason: str,
        message: str,
        weight: tuple[int, int, int] | None = None,
        backoff_until: int | None = None,
    ) -> None:
        denial: dict[str, Any] = {
            "provider": self._provider_id,
            "path": path,
            "reason": reason,
            "message": message,
        }
        if weight is not None:
            denial["used"], denial["cost"], denial["gate"] = weight
        if self._limits.local_budget is not None:
            denial["window_start"] = self._window_start
        until = self._backoff_until if backoff_until is None else backoff_until
        if until is not None:
            denial["backoff_until"] = until
        raise WeightBudgetError(message, denial)
