# frozen_string_literal: true

require "minitest/autorun"
require "json"
require "openreceive"

class OpenReceiveRatesTest < Minitest::Test
  SPEC_DIR = File.expand_path("../../../../spec", __dir__)

  # Deterministic injectable transport: responses is a Hash of url =>
  # callable or array of callables; each callable receives no args and
  # returns { status:, body: } or raises.
  class FakeHttp
    attr_reader :calls

    def initialize(responses)
      @responses = responses
      @calls = []
    end

    def call(url, headers, timeout_ms)
      @calls << { url: url, headers: headers, timeout_ms: timeout_ms }
      handler = @responses.fetch(url) { raise "unexpected url: #{url}" }
      handler = handler.shift if handler.is_a?(Array)
      handler.call
    end
  end

  def ok_body(rates)
    { status: 200, body: JSON.generate("bitcoin" => rates) }
  end

  def build_feed(primary:, fallback: nil, clock: -> { 0 }, currencies: ["USD"])
    responses = { "https://primary.test/price" => primary }
    responses["https://fallback.test/price"] = fallback unless fallback.nil?
    http = FakeHttp.new(responses)
    feed = OpenReceive::Rates.create_cached_live_price_feed(
      currencies: currencies,
      http: http,
      clock: clock,
      primary_url: "https://primary.test/price",
      fallback_url: "https://fallback.test/price"
    )
    [feed, http]
  end

  # --- drift check against the shared source of truth -----------------------

  def test_constants_match_spec_price_sources
    spec = JSON.parse(File.read(File.join(SPEC_DIR, "data/rates/price-sources.json")))
    assert_equal spec.fetch("cache_seconds"), OpenReceive::Rates::PRICE_FEED_CACHE_SECONDS
    assert_equal spec.fetch("invoice_quote_ttl_seconds"), OpenReceive::Rates::INVOICE_QUOTE_TTL_SECONDS
    assert_equal spec.fetch("primary_timeout_ms"), OpenReceive::Rates::PRICE_FEED_PRIMARY_TIMEOUT_MS

    by_id = spec.fetch("sources").to_h { |source| [source.fetch("id"), source] }
    assert_equal OpenReceive::Rates::PRICE_SOURCE_IDS.sort, by_id.keys.sort
    assert_equal by_id.fetch("primary").fetch("url"), OpenReceive::Rates::PRIMARY_PRICE_FEED_URL
    assert_equal by_id.fetch("fallback").fetch("url"), OpenReceive::Rates::FALLBACK_PRICE_FEED_URL
    assert_equal by_id.fetch("static_mock").fetch("rates"), OpenReceive::Rates::STATIC_BTC_FIAT_RATES
    assert_equal by_id.fetch("primary").fetch("env_override"), OpenReceive::Rates::PRICE_FEED_PRIMARY_URL_ENV
    assert_equal by_id.fetch("fallback").fetch("env_override"), OpenReceive::Rates::PRICE_FEED_FALLBACK_URL_ENV

    # Both live URLs must request exactly the hard-coded currency list.
    %w[primary fallback].each do |id|
      query = URI.decode_www_form(URI.parse(by_id.fetch(id).fetch("url")).query).to_h
      assert_equal "bitcoin", query.fetch("ids")
      assert_equal OpenReceive::Rates::PRICE_FEED_VS_CURRENCIES, query.fetch("vs_currencies")
    end
    assert_equal OpenReceive::Rates::PRICE_FEED_VS_CURRENCIES.split(","),
                 OpenReceive::Rates::PRICE_FEED_CURRENCIES
  end

  # --- static provider ------------------------------------------------------

  def test_static_provider_conversion_and_validation
    provider = OpenReceive::Rates::StaticPriceProvider.new
    assert_equal "static_mock", provider.source
    assert_equal "50000.00", provider.btc_fiat_price("USD")
    assert_equal({ "bitcoin" => { "usd" => "50000.00" } }, provider.btc_fiat_rates(["USD"]))
    assert_equal(
      { "source" => "static_mock", "rates" => { "bitcoin" => { "usd" => "50000.00" } } },
      provider.btc_fiat_rates_with_source(["USD"])
    )

    error = assert_raises(ArgumentError) { provider.btc_fiat_price("EUR") }
    assert_includes error.message, "unsupported static fiat currency: EUR"
    assert_raises(ArgumentError) { provider.btc_fiat_price("usd") }
    assert_raises(ArgumentError) { provider.btc_fiat_rates(["USDT"]) }
  end

  def test_static_provider_matches_shared_fiat_to_msats_vectors
    Dir[File.join(SPEC_DIR, "test-vectors/fiat-to-msats*.json")].sort.each do |path|
      vectors = JSON.parse(File.read(path))
      provider = OpenReceive::Rates::StaticPriceProvider.new
      vectors.fetch("cases").each do |vector|
        currency = vector.fetch("fiat").fetch("currency")
        price = provider.btc_fiat_price(currency)
        assert_equal vectors.fetch("btc_fiat_price"), price, vector.fetch("name")
        msats = OpenReceive.quote_fiat_to_msats(
          fiat_value: vector.fetch("fiat").fetch("value"),
          btc_fiat_price: price
        )
        assert_equal vector.fetch("expected").fetch("amount_msats"), msats, vector.fetch("name")
        assert_equal vector.fetch("expected").fetch("amount_sats"), msats / 1000, vector.fetch("name")
      end
    end
  end

  # --- live feed: caching ---------------------------------------------------

  def test_cached_feed_serves_from_cache_within_window_and_refreshes_after
    now = 0
    feed, http = build_feed(primary: -> { ok_body("usd" => "61234.56") }, clock: -> { now })

    first = feed.btc_fiat_rates_with_source(["USD"])
    assert_equal "primary", first.fetch("source")
    assert_equal "61234.56", first.fetch("rates").fetch("bitcoin").fetch("usd")
    assert_equal "61234.56", feed.btc_fiat_price("USD")

    now = 59
    feed.btc_fiat_rates(["USD"])
    assert_equal 1, http.calls.length, "reads within 60s must be served from cache"

    now = 60
    feed.btc_fiat_rates(["USD"])
    assert_equal 2, http.calls.length, "a 60s-old entry must trigger a live refresh"
  end

  def test_cached_feed_caches_whole_feed_and_selects_strictly
    feed, http = build_feed(primary: -> { ok_body("usd" => 50_000, "eur" => 46_000.5) })

    # Numeric JSON rates normalize to plain decimal strings (JS parity).
    assert_equal "50000", feed.btc_fiat_price("USD")
    # EUR was cached from the same single fetch even though only USD was configured.
    assert_equal "46000.5", feed.btc_fiat_price("EUR")
    assert_equal 1, http.calls.length

    # A currency the feed did not return fails strict selection.
    error = assert_raises(ArgumentError) { feed.btc_fiat_rates(["JPY"]) }
    assert_includes error.message, "bitcoin.jpy must be a number or decimal string"
    # Lowercase/invalid codes are rejected before any lookup.
    assert_raises(ArgumentError) { feed.btc_fiat_rates(["usd"]) }
  end

  # --- live feed: failover --------------------------------------------------

  def test_cached_feed_fails_over_to_fallback_url
    feed, http = build_feed(
      primary: -> { { status: 500, body: "oops" } },
      fallback: -> { ok_body("usd" => "58000.00") }
    )

    result = feed.btc_fiat_rates_with_source(["USD"])
    assert_equal "fallback", result.fetch("source")
    assert_equal "58000.00", result.fetch("rates").fetch("bitcoin").fetch("usd")
    assert_equal %w[https://primary.test/price https://fallback.test/price],
                 http.calls.map { |call| call[:url] }
    # The primary carries the 5s timeout; the fallback carries none.
    assert_equal [5000, nil], http.calls.map { |call| call[:timeout_ms] }
  end

  def test_cached_feed_fails_over_when_primary_times_out
    feed, _http = build_feed(
      primary: -> { raise Net::ReadTimeout },
      fallback: -> { ok_body("usd" => "58000.00") }
    )
    assert_equal "58000.00", feed.btc_fiat_price("USD")
  end

  # --- live feed: failure + staleness ---------------------------------------

  def test_cached_feed_fails_closed_after_both_feeds_fail
    now = 0
    feed, http = build_feed(
      primary: [
        -> { raise Errno::ECONNREFUSED },
        -> { ok_body("usd" => "59000.00") }
      ],
      fallback: -> { { status: 503, body: "down" } },
      clock: -> { now }
    )

    error = assert_raises(OpenReceive::PriceFeedError) { feed.btc_fiat_price("USD") }
    assert_includes error.message, "all price feeds failed"
    assert_includes error.message, "primary:"
    assert_includes error.message, "fallback: price source fallback returned HTTP 503"
    calls_after_failure = http.calls.length

    # Within the cache window the failure is remembered without new requests.
    now = 30
    error = assert_raises(OpenReceive::PriceFeedError) { feed.btc_fiat_price("USD") }
    assert_includes error.message, "price feed refresh already failed within 60s"
    assert_equal calls_after_failure, http.calls.length

    # After the window a refresh is retried and succeeds.
    now = 60
    assert_equal "59000.00", feed.btc_fiat_price("USD")
  end

  def test_cached_feed_serves_stale_entry_during_inflight_refresh_within_quote_ttl
    now = 0
    feed = nil
    nested = nil
    primary = [
      -> { ok_body("usd" => "50000.00") },
      lambda do
        # Re-enter the feed while this refresh is in flight: the stale entry
        # (age 70s < 600s quote TTL) must be served rather than re-fetched.
        nested = feed.btc_fiat_rates_with_source(["USD"])
        ok_body("usd" => "51000.00")
      end
    ]
    feed, http = build_feed(primary: primary, clock: -> { now })

    feed.btc_fiat_rates(["USD"])
    now = 70
    refreshed = feed.btc_fiat_rates_with_source(["USD"])

    assert_equal "50000.00", nested.fetch("rates").fetch("bitcoin").fetch("usd")
    assert_equal "51000.00", refreshed.fetch("rates").fetch("bitcoin").fetch("usd")
    assert_equal 2, http.calls.length
  end

  def test_cached_feed_fails_closed_during_inflight_refresh_when_entry_older_than_quote_ttl
    now = 0
    feed = nil
    nested_error = nil
    primary = [
      -> { ok_body("usd" => "50000.00") },
      lambda do
        # The cached entry is 700s old — older than any quote may live — so a
        # concurrent read must fail closed instead of serving it.
        nested_error = assert_raises(OpenReceive::PriceFeedError) { feed.btc_fiat_price("USD") }
        ok_body("usd" => "51000.00")
      end
    ]
    feed, _http = build_feed(primary: primary, clock: -> { now })

    feed.btc_fiat_rates(["USD"])
    now = 700
    feed.btc_fiat_rates(["USD"])
    assert_includes nested_error.message, "price feed refresh already started within 60s"
  end

  # --- health check ---------------------------------------------------------

  def test_health_check_forces_refresh_and_reports_source
    now = 0
    feed, http = build_feed(
      primary: [
        -> { ok_body("usd" => "50000.00") },
        -> { { status: 500, body: "oops" } }
      ],
      fallback: -> { ok_body("usd" => "58000.00", "bad" => "not-a-number") },
      clock: -> { now }
    )

    feed.btc_fiat_price("USD")
    assert_equal 1, http.calls.length

    # Even with a fresh cache, health check performs a live probe; a
    # malformed individual currency does not fail it.
    probe = feed.health_check(["USD"])
    assert_equal "fallback", probe.fetch("source")
    assert_equal "58000.00", probe.fetch("rates").fetch("bitcoin").fetch("usd")
    assert_equal 3, http.calls.length

    full = feed.health_check
    refute full.fetch("rates").fetch("bitcoin").key?("bad")
  end

  def test_health_check_raises_when_all_feeds_fail
    feed, _http = build_feed(
      primary: -> { { status: 500, body: "oops" } },
      fallback: -> { raise SocketError, "getaddrinfo failed" }
    )
    error = assert_raises(OpenReceive::PriceFeedError) { feed.health_check }
    assert_includes error.message, "all price feeds failed"
  end

  # --- misc ----------------------------------------------------------------

  def test_feed_requires_at_least_one_currency
    providers = OpenReceive::Rates.create_live_price_feed_providers
    error = assert_raises(ArgumentError) do
      OpenReceive::Rates::CachedPriceFeed.new(
        currencies: [],
        primary: providers.fetch(:primary),
        fallback: providers.fetch(:fallback)
      )
    end
    assert_includes error.message, "requires at least one currency"
  end

  def test_env_override_reader
    env = {
      "OPENRECEIVE_PRICE_FEED_PRIMARY_URL" => "  https://override.test/price ",
      "OPENRECEIVE_PRICE_FEED_FALLBACK_URL" => "   "
    }
    overrides = OpenReceive::Rates.read_price_feed_url_overrides(env)
    assert_equal "https://override.test/price", overrides.fetch(:primary_url)
    assert_nil overrides.fetch(:fallback_url)
  end
end
