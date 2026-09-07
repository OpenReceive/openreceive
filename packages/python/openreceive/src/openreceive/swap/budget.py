"""A disposable per-process request guard for the provider API; the provider
remains the global rate-limit authority. Twin of Ruby
`Swap::SwapProviderWeightBudget` (JS weight-budget.ts)."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

WINDOW_SECONDS = 60
SOFT_CAP = 200
CREATE_GATE = 150
CREATE_WEIGHT = 50
DEFAULT_WEIGHT = 1
BACKOFF_SECONDS = 60


class WeightBudgetError(RuntimeError):
    """Raised when a reservation would exceed the budget. `weight_budget` is
    the marker quote classification maps to provider_rate_limited."""

    weight_budget = True

    def __init__(self, message: str, denial: dict[str, Any]) -> None:
        super().__init__(message)
        self.denial = denial


class SwapProviderWeightBudget:
    def __init__(self, provider_id: str, clock: Callable[[], int]) -> None:
        self._provider_id = provider_id
        self._clock = clock
        self._window_start = clock()
        self._used = 0
        self._backoff_until: int | None = None
        self._lock = threading.Lock()

    @staticmethod
    def weight_for_path(path: str) -> int:
        return CREATE_WEIGHT if path == "create" else DEFAULT_WEIGHT

    def reserve(self, path: str) -> None:
        with self._lock:
            self._roll_window()
            now = self._clock()
            cost = self.weight_for_path(path)
            limit = CREATE_GATE if path == "create" else SOFT_CAP
            if self._backoff_until is not None and self._backoff_until > now:
                self._deny(
                    path,
                    "backoff",
                    cost,
                    limit,
                    f"Swap provider API is in backoff until {self._backoff_until}.",
                )
            if self._used + cost > limit:
                self._deny(
                    path,
                    "exhausted",
                    cost,
                    limit,
                    f"Swap provider API weight budget exhausted ({self._used}+{cost} > {limit}).",
                )
            self._used += cost

    def mark_rate_limited(self) -> None:
        with self._lock:
            self._used = max(self._used, SOFT_CAP)
            self._backoff_until = self._clock() + BACKOFF_SECONDS

    def _roll_window(self) -> None:
        # The weight window rolls; the 429 backoff does NOT ride along with it
        # and expires on its own clock, checked in reserve.
        now = self._clock()
        if now - self._window_start < WINDOW_SECONDS:
            return
        self._window_start = now
        self._used = 0

    def _deny(self, path: str, reason: str, cost: int, limit: int, message: str) -> None:
        denial: dict[str, Any] = {
            "provider": self._provider_id,
            "path": path,
            "reason": reason,
            "message": message,
            "used": self._used,
            "cost": cost,
            "gate": limit,
            "window_start": self._window_start,
        }
        if self._backoff_until is not None:
            denial["backoff_until"] = self._backoff_until
        raise WeightBudgetError(message, denial)
