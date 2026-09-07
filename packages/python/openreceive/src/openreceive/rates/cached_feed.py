"""BTC fiat rates from a disposable process-local cache, refreshing from the
primary feed first and the fallback second. Port of the JS/Ruby CachedPriceFeed
state machine: fresh entries are served for cache_seconds; a refresh failure
fails CLOSED for cache_seconds; a concurrent in-flight refresh serves the
stale entry only while it is younger than the invoice quote TTL."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any, Protocol

from openreceive import rates


class PriceSource(Protocol):
    source: str

    def btc_fiat_rates(self, currencies: list[str]) -> dict[str, Any]: ...


class CachedPriceFeed:
    def __init__(
        self,
        *,
        currencies: list[str],
        primary: PriceSource,
        fallback: PriceSource,
        cache_seconds: int | None = None,
        clock: Callable[[], int] | None = None,
    ) -> None:
        if not currencies:
            raise ValueError("CachedPriceFeed requires at least one currency")
        seconds = rates.PRICE_FEED_CACHE_SECONDS if cache_seconds is None else cache_seconds
        if not isinstance(seconds, int) or isinstance(seconds, bool) or seconds <= 0:
            raise ValueError("CachedPriceFeed cache_seconds must be a positive integer")
        if seconds > rates.INVOICE_QUOTE_TTL_SECONDS:
            raise ValueError(
                f"CachedPriceFeed cache_seconds must not exceed the {rates.INVOICE_QUOTE_TTL_SECONDS}s invoice quote TTL"
            )
        self._currencies = [str(currency) for currency in currencies]
        self._primary = primary
        self._fallback = fallback
        self._cache_seconds = seconds
        self._clock: Callable[[], int] = clock or (lambda: int(time.time()))
        self.source = "primary"
        self._lock = threading.Lock()
        self._refresh_done = threading.Condition(self._lock)
        self._state: dict[str, Any] | None = None
        self._in_flight: dict[str, Any] | None = None

    def btc_fiat_rates(self, currencies: list[str]) -> dict[str, Any]:
        result: dict[str, Any] = self.btc_fiat_rates_with_source(currencies)["rates"]
        return result

    def btc_fiat_rates_with_source(self, currencies: list[str]) -> dict[str, Any]:
        now = self._clock()
        claim = self._read_or_claim_refresh(now)
        if claim["status"] == "served":
            entry = claim["entry"]
        elif claim["status"] == "pending":
            entry = self._await_refresh(claim["pending"])
        else:
            entry = self._tracked_refresh(now, claim["previous_entry"], claim["pending"])
        return {
            "source": entry["source"],
            "rates": rates.parse_simple_price_response(entry["rates"], currencies),
        }

    def btc_fiat_price(self, currency: str) -> str:
        """The server price_provider contract: one decimal price string for one
        uppercase ISO 4217 currency."""
        price: str = self.btc_fiat_rates([currency])["bitcoin"][
            rates.normalize_fiat_currency(currency)
        ]
        return price

    def health_check(self, currencies: list[str] | None = None) -> dict[str, Any]:
        """Forces a live refresh, ignoring the cache. Raises if both feeds fail."""
        now = self._clock()
        pending: dict[str, Any] = {"owner": threading.get_ident(), "done": False}
        with self._lock:
            self._in_flight = pending
            previous_entry = self._state.get("entry") if self._state else None
        entry = self._tracked_refresh(now, previous_entry, pending)
        selected = (
            entry["rates"]
            if not currencies
            else rates.parse_simple_price_response(entry["rates"], currencies)
        )
        return {"source": entry["source"], "rates": selected}

    def _read_or_claim_refresh(self, now: int) -> dict[str, Any]:
        with self._lock:
            state = self._state
            entry = state.get("entry") if state else None
            entry_age = self._stamp_age(entry["fetched_at"], now) if entry else None
            if entry_age is not None and entry_age < self._cache_seconds:
                return {"status": "served", "entry": entry}
            # Stale-while-revalidate is bounded by the invoice quote TTL.
            quotable = (
                entry
                if entry_age is not None and entry_age < rates.INVOICE_QUOTE_TTL_SECONDS
                else None
            )
            if state and self._recent(state.get("refresh_failed_at"), now):
                if quotable is not None:
                    return {"status": "served", "entry": quotable}
                message = f"price feed refresh already failed within {self._cache_seconds}s"
                if state.get("refresh_error"):
                    message += f": {state['refresh_error']}"
                raise rates.PriceFeedError(message)
            if state and self._recent(state.get("refresh_started_at"), now):
                if quotable is not None:
                    return {"status": "served", "entry": quotable}
                # Cold cache: join the refresh already running in this process.
                pending = self._in_flight
                if pending is not None and pending["owner"] != threading.get_ident():
                    return {"status": "pending", "pending": pending}
                raise rates.PriceFeedError(
                    f"price feed refresh already started within {self._cache_seconds}s"
                )
            claimed: dict[str, Any] = {"refresh_started_at": now}
            if entry is not None:
                claimed["entry"] = entry
            self._state = claimed
            pending = {"owner": threading.get_ident(), "done": False}
            self._in_flight = pending
            return {"status": "claimed", "previous_entry": entry, "pending": pending}

    def _recent(self, timestamp: int | None, now: int) -> bool:
        age = self._stamp_age(timestamp, now)
        return age is not None and age < self._cache_seconds

    @staticmethod
    def _stamp_age(timestamp: int | None, now: int) -> int | None:
        if timestamp is None:
            return None
        age = now - timestamp
        if age < -rates.PRICE_FEED_CLOCK_SKEW_SECONDS:
            return None
        return max(age, 0)

    def _tracked_refresh(
        self, now: int, previous_entry: dict[str, Any] | None, pending: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            entry = self._refresh(now, previous_entry)
        except Exception as error:
            self._settle(pending, None, error)
            raise
        self._settle(pending, entry, None)
        return entry

    def _settle(
        self, pending: dict[str, Any], entry: dict[str, Any] | None, error: BaseException | None
    ) -> None:
        with self._lock:
            pending["entry"] = entry
            pending["error"] = error
            pending["done"] = True
            if self._in_flight is pending:
                self._in_flight = None
            self._refresh_done.notify_all()

    def _await_refresh(self, pending: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            while not pending["done"]:
                self._refresh_done.wait()
        if pending["error"] is not None:
            raise pending["error"]
        entry: dict[str, Any] = pending["entry"]
        return entry

    def _refresh(self, now: int, previous_entry: dict[str, Any] | None) -> dict[str, Any]:
        failures: list[str] = []
        for provider in (self._primary, self._fallback):
            try:
                fetched = self._fetch_provider_rates(provider)
                entry = {"rates": fetched, "source": provider.source, "fetched_at": now}
                with self._lock:
                    self._state = {"entry": entry}
                return entry
            except Exception as error:
                failures.append(f"{provider.source}: {error}")
        message = "all price feeds failed: " + "; ".join(failures)
        with self._lock:
            failed: dict[str, Any] = {
                "refresh_started_at": now,
                "refresh_failed_at": now,
                "refresh_error": message,
            }
            if previous_entry is not None:
                failed["entry"] = previous_entry
            self._state = failed
        raise rates.PriceFeedError(message)

    def _fetch_provider_rates(self, provider: PriceSource) -> dict[str, Any]:
        all_rates = getattr(provider, "all_btc_fiat_rates", None)
        if callable(all_rates):
            result: dict[str, Any] = all_rates()
            return result
        return provider.btc_fiat_rates(self._currencies)
