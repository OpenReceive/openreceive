"""A disposable, process-local provider catalog/rate cache with no storage
adapter. Concurrent resolves of one key join one fetch: the first caller
claims the key under the lock, runs fetch outside it, and writes back under
the lock; joiners wait on a per-key condition. Twin of Ruby
`Swap::TransientSwapCache` (JS limits-cache.ts)."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

MAX_STALE_SECONDS = 48 * 60 * 60
REFRESH_CLAIM_SECONDS = 60


class SwapCacheError(RuntimeError):
    pass


def limits_meta_key(provider_name: str) -> str:
    return f"swap_limits:{provider_name}"


class TransientSwapCache:
    def __init__(
        self, clock: Callable[[], int], warn: Callable[[str, dict[str, Any]], None] | None = None
    ) -> None:
        self._clock = clock
        self._warn = warn
        self._states: dict[str, dict[str, Any]] = {}
        self._inflight: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def resolve(
        self,
        key: str,
        *,
        refresh_seconds: int,
        max_stale_seconds: int,
        fetch: Callable[[], Any],
        serialize: Callable[[Any], str],
        deserialize: Callable[[str], Any],
        claim_seconds: int = REFRESH_CLAIM_SECONDS,
        serve_stale_on_failure: bool = True,
    ) -> Any:
        with self._lock:
            now = self._clock()
            state = self._states.get(key)
            if (
                state
                and state.get("value") is not None
                and state.get("fetched_at") is not None
                and now - state["fetched_at"] < refresh_seconds
            ):
                return deserialize(state["value"])
            if (
                state
                and state.get("failed_at") is not None
                and now - state["failed_at"] < claim_seconds
            ):
                return self._stale_or_raise(
                    key, state, now, max_stale_seconds, serve_stale_on_failure, deserialize
                )
            active = self._inflight.get(key)
            if active is not None:
                while not active["settled"]:
                    active["cond"].wait()
                if active["error"] is not None:
                    raise active["error"]
                return active["value"]
            claim: dict[str, Any] = {
                "settled": False,
                "cond": threading.Condition(self._lock),
                "value": None,
                "error": None,
            }
            self._inflight[key] = claim
        try:
            try:
                value = fetch()
                with self._lock:
                    self._states[key] = {"value": serialize(value), "fetched_at": now}
                result = value
            except Exception as error:
                failed: dict[str, Any] = {"failed_at": now, "error": str(error)}
                if state and state.get("value") is not None:
                    failed["value"] = state["value"]
                if state and state.get("fetched_at") is not None:
                    failed["fetched_at"] = state["fetched_at"]
                with self._lock:
                    self._states[key] = failed
                result = self._stale_or_raise(
                    key,
                    failed,
                    now,
                    max_stale_seconds,
                    serve_stale_on_failure,
                    deserialize,
                    cause=error,
                )
            self._settle(key, claim, value=result)
            return result
        except Exception as error:
            self._settle(key, claim, error=error)
            raise

    def _settle(
        self,
        key: str,
        claim: dict[str, Any],
        *,
        value: Any = None,
        error: BaseException | None = None,
    ) -> None:
        with self._lock:
            claim["value"] = value
            claim["error"] = error
            claim["settled"] = True
            claim["cond"].notify_all()
            if self._inflight.get(key) is claim:
                del self._inflight[key]

    def _stale_or_raise(
        self,
        key: str,
        state: dict[str, Any],
        now: int,
        max_stale_seconds: int,
        serve_stale_on_failure: bool,
        deserialize: Callable[[str], Any],
        cause: BaseException | None = None,
    ) -> Any:
        if (
            serve_stale_on_failure
            and state.get("value") is not None
            and state.get("fetched_at") is not None
            and now - state["fetched_at"] < max_stale_seconds
        ):
            if self._warn is not None:
                self._warn(
                    "Serving stale swap provider data after refresh failed.",
                    {"key": key, "error": state.get("error")},
                )
            return deserialize(state["value"])
        if cause is not None:
            raise cause
        raise SwapCacheError(state.get("error") or "Swap provider cache refresh failed.")
