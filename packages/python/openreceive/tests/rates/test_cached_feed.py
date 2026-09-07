from typing import Any

import pytest

from openreceive import rates
from openreceive.rates import CachedPriceFeed, HttpSimplePriceProvider, StaticPriceProvider


class Source:
    def __init__(self, name: str, answers: list[Any]) -> None:
        self.source = name
        self.answers = answers
        self.calls = 0

    def btc_fiat_rates(self, currencies: list[str]) -> dict[str, Any]:
        self.calls += 1
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return rates.parse_simple_price_response(answer, currencies)


def test_static_price_is_the_shared_fixture() -> None:
    assert StaticPriceProvider().btc_fiat_price("USD") == "50000.00"
    with pytest.raises(ValueError):
        StaticPriceProvider().btc_fiat_price("EUR")


def test_cached_feed_serves_fresh_then_fails_closed() -> None:
    now = {"value": 1000}
    primary = Source("primary", [{"bitcoin": {"usd": 60000}}, RuntimeError("down")])
    fallback = Source("fallback", [RuntimeError("down too")])
    feed = CachedPriceFeed(
        currencies=["USD"], primary=primary, fallback=fallback, clock=lambda: now["value"]
    )
    assert feed.btc_fiat_price("USD") == "60000"
    assert feed.btc_fiat_price("USD") == "60000"  # cached: no second fetch
    assert primary.calls == 1
    # Past the cache window but inside the quote TTL: the read that claims the
    # refresh sees both feeds fail; the reads that follow inside the backoff
    # serve the still-quotable observation instead of hard-downing quoting.
    now["value"] = 1100
    with pytest.raises(rates.PriceFeedError, match="all price feeds failed"):
        feed.btc_fiat_price("USD")
    assert feed.btc_fiat_price("USD") == "60000"
    assert primary.calls == 2
    # Past the quote TTL with a failed refresh inside the backoff: fail closed.
    now["value"] = 1100 + rates.INVOICE_QUOTE_TTL_SECONDS
    primary.answers.append(RuntimeError("still down"))
    fallback.answers.append(RuntimeError("still down"))
    with pytest.raises(rates.PriceFeedError):
        feed.btc_fiat_price("USD")


def test_cached_feed_falls_back_to_the_second_source() -> None:
    primary = Source("primary", [RuntimeError("down")])
    fallback = Source("fallback", [{"bitcoin": {"usd": "51000.5"}}])
    feed = CachedPriceFeed(currencies=["USD"], primary=primary, fallback=fallback, clock=lambda: 5)
    assert feed.btc_fiat_rates_with_source(["USD"]) == {
        "source": "fallback",
        "rates": {"bitcoin": {"usd": "51000.5"}},
    }


def test_cache_window_must_fit_the_quote_ttl() -> None:
    with pytest.raises(ValueError):
        CachedPriceFeed(
            currencies=["USD"], primary=Source("p", []), fallback=Source("f", []), cache_seconds=601
        )


def test_http_provider_reads_simple_price_json_and_reports_timeouts() -> None:
    def http(url: str, headers: Any, timeout_ms: int | None) -> dict[str, Any]:
        assert headers["accept"] == "application/json"
        assert timeout_ms == 5000
        return {"status": 200, "body": '{"bitcoin": {"usd": 42000.25, "eur": "bad", "xxxx": 1}}'}

    provider = HttpSimplePriceProvider(
        url="https://feed.test/", source="primary", http=http, timeout_ms=5000
    )
    assert provider.all_btc_fiat_rates() == {"bitcoin": {"usd": "42000.25"}}
    assert provider.btc_fiat_rates(["USD"]) == {"bitcoin": {"usd": "42000.25"}}

    def slow(url: str, headers: Any, timeout_ms: int | None) -> dict[str, Any]:
        raise TimeoutError("read timed out")

    with pytest.raises(rates.PriceFeedError, match="did not respond within 5000ms"):
        HttpSimplePriceProvider(
            url="u", source="primary", http=slow, timeout_ms=5000
        ).btc_fiat_rates(["USD"])


def test_url_overrides_read_from_env_only_when_present() -> None:
    assert rates.read_price_feed_url_overrides({}) == {"primary_url": None, "fallback_url": None}
    assert (
        rates.read_price_feed_url_overrides({"OPENRECEIVE_PRICE_FEED_PRIMARY_URL": " http://x "})[
            "primary_url"
        ]
        == "http://x"
    )
