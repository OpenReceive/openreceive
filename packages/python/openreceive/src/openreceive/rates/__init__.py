"""The built-in BTC price feed: the static provider plus the cached live feed
with primary/fallback failover. Twin of Ruby `OpenReceive::Rates` / the JS
`core/src/rates`. Constants are hand-written and drift-checked against
`spec/data/rates/price-sources.json` by the JS and Ruby test suites."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from decimal import Decimal
from typing import Any

from openreceive import money

PRICE_FEED_CACHE_SECONDS = 60
INVOICE_QUOTE_TTL_SECONDS = 600
# A cache stamp this far in the future means the clock stepped backwards.
PRICE_FEED_CLOCK_SKEW_SECONDS = 5
# The primary feed must answer within this window before the fallback is tried.
PRICE_FEED_PRIMARY_TIMEOUT_MS = 5000

PRICE_SOURCE_IDS = ("static_mock", "primary", "fallback")
STATIC_PRICE_SOURCE_ID = "static_mock"
STATIC_BTC_FIAT_RATES: dict[str, dict[str, str]] = {"bitcoin": {"usd": "50000.00"}}

# The fixed fiat list both live feeds price Bitcoin against.
PRICE_FEED_VS_CURRENCIES = (
    "usd,aed,ars,aud,bdt,bhd,bmd,brl,cad,chf,clp,cny,czk,dkk,eur,gbp,gel,hkd,huf,idr,ils,inr,"
    "jpy,krw,kwd,lkr,mmk,mxn,myr,ngn,nok,nzd,php,pkr,pln,rub,sar,sek,sgd,thb,try,twd,uah,vef,vnd,zar"
)
PRICE_FEED_CURRENCIES = tuple(PRICE_FEED_VS_CURRENCIES.split(","))
SIMPLE_PRICE_BASE_URL = "https://api.coingecko.com/api/v3/simple/price"
PRIMARY_PRICE_FEED_URL = (
    f"{SIMPLE_PRICE_BASE_URL}?ids=bitcoin&vs_currencies={PRICE_FEED_VS_CURRENCIES}"
)
FALLBACK_PRICE_FEED_URL = f"https://openreceive.org/api/v3/simple/price?ids=bitcoin&vs_currencies={PRICE_FEED_VS_CURRENCIES}"
PRICE_FEED_PRIMARY_URL_ENV = "OPENRECEIVE_PRICE_FEED_PRIMARY_URL"
PRICE_FEED_FALLBACK_URL_ENV = "OPENRECEIVE_PRICE_FEED_FALLBACK_URL"

CURRENCY_PATTERN = re.compile(r"\A[A-Z]{3}\Z")
RATE_KEY_PATTERN = re.compile(r"\A[a-z]{3}\Z")


class PriceFeedError(RuntimeError):
    """A live price feed cannot serve a usable rate (network failure, bad HTTP
    status, refresh fail-closed window). Validation problems raise ValueError."""


def normalize_fiat_currency(currency: object) -> str:
    if not isinstance(currency, str) or CURRENCY_PATTERN.match(currency) is None:
        raise ValueError("fiat.currency must be an ISO 4217 uppercase code")
    return currency.lower()


def static_btc_fiat_price(currency: object) -> str:
    rate = STATIC_BTC_FIAT_RATES["bitcoin"].get(normalize_fiat_currency(currency))
    if rate is None:
        raise ValueError(f"unsupported static fiat currency: {currency}")
    return rate


def parse_simple_price_response(response: object, currencies: list[str]) -> dict[str, Any]:
    """Strict select: every requested currency must be present and well formed."""
    bitcoin = _as_record(_as_record(response).get("bitcoin"))
    rates: dict[str, str] = {}
    for currency in currencies:
        key = normalize_fiat_currency(currency)
        rates[key] = normalize_btc_fiat_rate(bitcoin.get(key), f"bitcoin.{key}")
    return {"bitcoin": rates}


def parse_available_simple_price_response(response: object) -> dict[str, Any]:
    """Tolerant parse for caching the whole feed: keeps every well-formed
    currency and skips unusable ones; raises only when nothing is usable."""
    bitcoin = _as_record(_as_record(response).get("bitcoin"))
    rates: dict[str, str] = {}
    for key, value in bitcoin.items():
        rate_key = str(key).lower()
        if RATE_KEY_PATTERN.match(rate_key) is None:
            continue
        try:
            rates[rate_key] = normalize_btc_fiat_rate(value, f"bitcoin.{key}")
        except ValueError:
            continue
    if not rates:
        raise ValueError("price response contained no usable BTC fiat rates")
    return {"bitcoin": rates}


def normalize_btc_fiat_rate(value: object, field: str) -> str:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a number or decimal string")
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            raise ValueError(f"{field} must be a positive number")
        if value <= 0:
            raise ValueError(f"{field} must be a positive number")
        normalized = number_to_plain_decimal_string(value)
        money.decimal(normalized, field)
        return normalized
    if isinstance(value, str):
        money.decimal(value, field)
        return value
    raise ValueError(f"{field} must be a number or decimal string")


def number_to_plain_decimal_string(value: float | int) -> str:
    """Plain decimal notation for any JSON number, never exponent form."""
    if isinstance(value, int):
        return str(value)
    text = format(Decimal(repr(value)), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def _as_record(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("expected object")
    return {str(key): item for key, item in value.items()}


def read_price_feed_url_overrides(env: Mapping[str, str]) -> dict[str, str | None]:
    """Host-side helper: non-empty URL overrides from the well-known env names.
    The feed itself never reads the environment."""
    return {
        "primary_url": (env.get(PRICE_FEED_PRIMARY_URL_ENV) or "").strip() or None,
        "fallback_url": (env.get(PRICE_FEED_FALLBACK_URL_ENV) or "").strip() or None,
    }


from openreceive.rates.cached_feed import CachedPriceFeed  # noqa: E402
from openreceive.rates.simple_price import HttpGet, HttpSimplePriceProvider  # noqa: E402
from openreceive.rates.static import StaticPriceProvider  # noqa: E402


def create_live_price_feed_providers(
    *,
    http: HttpGet | None = None,
    primary_url: str | None = None,
    fallback_url: str | None = None,
    primary_timeout_ms: int | None = None,
) -> dict[str, HttpSimplePriceProvider]:
    return {
        "primary": HttpSimplePriceProvider(
            url=primary_url or PRIMARY_PRICE_FEED_URL,
            source="primary",
            http=http,
            timeout_ms=primary_timeout_ms or PRICE_FEED_PRIMARY_TIMEOUT_MS,
        ),
        "fallback": HttpSimplePriceProvider(
            url=fallback_url or FALLBACK_PRICE_FEED_URL, source="fallback", http=http
        ),
    }


def create_cached_live_price_feed(
    *,
    currencies: list[str],
    http: HttpGet | None = None,
    clock: Callable[[], int] | None = None,
    cache_seconds: int | None = None,
    primary_url: str | None = None,
    fallback_url: str | None = None,
    primary_timeout_ms: int | None = None,
) -> CachedPriceFeed:
    providers = create_live_price_feed_providers(
        http=http,
        primary_url=primary_url,
        fallback_url=fallback_url,
        primary_timeout_ms=primary_timeout_ms,
    )
    return CachedPriceFeed(
        currencies=currencies,
        primary=providers["primary"],
        fallback=providers["fallback"],
        cache_seconds=cache_seconds,
        clock=clock,
    )


__all__ = [
    "CachedPriceFeed",
    "HttpSimplePriceProvider",
    "PriceFeedError",
    "StaticPriceProvider",
    "create_cached_live_price_feed",
    "create_live_price_feed_providers",
    "normalize_fiat_currency",
    "parse_available_simple_price_response",
    "parse_simple_price_response",
    "read_price_feed_url_overrides",
    "static_btc_fiat_price",
]
