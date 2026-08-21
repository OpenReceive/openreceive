# frozen_string_literal: true

require "bigdecimal"
require "json"
require "net/http"
require "uri"

module OpenReceive
  # Raised when a live price feed cannot serve a usable rate (network failure,
  # bad HTTP status, refresh fail-closed windows). Mirrors the plain Error the
  # JS feed throws; validation problems raise ArgumentError instead (the Ruby
  # spelling of the JS RangeError).
  class PriceFeedError < StandardError; end

  # Ruby port of packages/js/core/src/rates/index.ts: the built-in BTC price
  # feed (static provider plus cached live feed with primary/fallback
  # failover). Constants are hand-written and drift-checked against
  # spec/data/rates/price-sources.json by test/rates_test.rb, exactly like the
  # JS constants are checked by tests/rates.test.mjs.
  module Rates
    # How long a cached price-feed read stays usable before a live refresh.
    PRICE_FEED_CACHE_SECONDS = 60
    INVOICE_QUOTE_TTL_SECONDS = 600
    # A cache stamp this far in the future means the clock stepped backwards:
    # treat the stamp as stale rather than "fresh until wall-clock catches up".
    PRICE_FEED_CLOCK_SKEW_SECONDS = 5

    # The primary feed must answer within this window before the fallback is tried.
    PRICE_FEED_PRIMARY_TIMEOUT_MS = 5000

    PRICE_SOURCE_IDS = %w[static_mock primary fallback].freeze
    STATIC_PRICE_SOURCE_ID = "static_mock"

    STATIC_BTC_FIAT_RATES = {
      "bitcoin" => {
        "usd" => "50000.00"
      }.freeze
    }.freeze

    # The fixed fiat list both live feeds price Bitcoin against. Hard-coded so
    # the primary and fallback URLs always request the same currencies.
    PRICE_FEED_VS_CURRENCIES =
      "usd,aed,ars,aud,bdt,bhd,bmd,brl,cad,chf,clp,cny,czk,dkk,eur,gbp,gel,hkd,huf,idr,ils,inr,jpy,krw,kwd,lkr,mmk,mxn,myr,ngn,nok,nzd,php,pkr,pln,rub,sar,sek,sgd,thb,try,twd,uah,vef,vnd,zar"

    PRICE_FEED_CURRENCIES = PRICE_FEED_VS_CURRENCIES.split(",").freeze

    SIMPLE_PRICE_BASE_URL = "https://api.coingecko.com/api/v3/simple/price"

    # Primary live feed: the canonical public Simple Price endpoint.
    PRIMARY_PRICE_FEED_URL =
      "#{SIMPLE_PRICE_BASE_URL}?ids=bitcoin&vs_currencies=#{PRICE_FEED_VS_CURRENCIES}"

    # Fallback live feed: the OpenReceive mirror, in the same response shape.
    FALLBACK_PRICE_FEED_URL =
      "https://openreceive.org/api/v3/simple/price?ids=bitcoin&vs_currencies=#{PRICE_FEED_VS_CURRENCIES}"

    # Dev override env var names. Hosts read these (see
    # read_price_feed_url_overrides) and pass any override into the factory;
    # the feed itself never reads the environment.
    PRICE_FEED_PRIMARY_URL_ENV = "OPENRECEIVE_PRICE_FEED_PRIMARY_URL"
    PRICE_FEED_FALLBACK_URL_ENV = "OPENRECEIVE_PRICE_FEED_FALLBACK_URL"

    CURRENCY_PATTERN = /\A[A-Z]{3}\z/
    RATE_KEY_PATTERN = /\A[a-z]{3}\z/

    module_function

    def normalize_fiat_currency(currency)
      unless currency.is_a?(String) && CURRENCY_PATTERN.match?(currency)
        raise ArgumentError, "fiat.currency must be an ISO 4217 uppercase code"
      end
      currency.downcase
    end

    def static_btc_fiat_price(currency)
      rate = STATIC_BTC_FIAT_RATES.fetch("bitcoin")[normalize_fiat_currency(currency)]
      raise ArgumentError, "unsupported static fiat currency: #{currency}" if rate.nil?
      rate
    end

    # Strict select: every requested currency must be present and well formed.
    def parse_simple_price_response(response, currencies)
      bitcoin = as_record(as_record(response)["bitcoin"])
      rates = {}
      currencies.each do |currency|
        key = normalize_fiat_currency(currency)
        rates[key] = normalize_btc_fiat_rate(bitcoin[key], "bitcoin.#{key}")
      end
      { "bitcoin" => rates }
    end

    # Tolerant parse for caching the whole feed: keeps every well-formed
    # currency the response carries and skips ones an upstream returned
    # unusably (so a single dropped currency never fails the refresh). Raises
    # only when the response is not Simple Price shaped or carries no usable
    # rate at all.
    def parse_available_simple_price_response(response)
      bitcoin = as_record(as_record(response)["bitcoin"])
      rates = {}
      bitcoin.each do |key, value|
        rate_key = key.to_s.downcase
        next unless RATE_KEY_PATTERN.match?(rate_key)
        begin
          rates[rate_key] = normalize_btc_fiat_rate(value, "bitcoin.#{key}")
        rescue ArgumentError
          # Skip a currency the upstream returned in an unusable form.
        end
      end
      raise ArgumentError, "price response contained no usable BTC fiat rates" if rates.empty?
      { "bitcoin" => rates }
    end

    def normalize_btc_fiat_rate(value, field)
      if value.is_a?(Numeric)
        unless value.finite? && value.positive?
          raise ArgumentError, "#{field} must be a positive number"
        end
        normalized = number_to_plain_decimal_string(value)
        Money.decimal(normalized, field)
        return normalized
      end

      if value.is_a?(String)
        Money.decimal(value, field)
        return value
      end

      raise ArgumentError, "#{field} must be a number or decimal string"
    end

    # Expand any JSON number an upstream price source returns to plain decimal
    # notation (never exponent form), matching JS numberToPlainDecimalString.
    def number_to_plain_decimal_string(value)
      return value.to_s if value.is_a?(Integer)
      decimal = BigDecimal(value.to_s)
      text = decimal.to_s("F")
      decimal.frac.zero? ? text.sub(/\.0+\z/, "") : text
    end

    def as_record(value)
      raise ArgumentError, "expected object" unless value.is_a?(Hash)
      value
    end

    # Builds the primary and fallback live feed providers from the hard-coded
    # URLs (or caller overrides). The primary provider carries the 5s timeout.
    def create_live_price_feed_providers(http: nil, primary_url: nil, fallback_url: nil, primary_timeout_ms: nil)
      {
        primary: HttpSimplePriceProvider.new(
          url: primary_url || PRIMARY_PRICE_FEED_URL,
          source: "primary",
          http: http,
          timeout_ms: primary_timeout_ms || PRICE_FEED_PRIMARY_TIMEOUT_MS
        ),
        fallback: HttpSimplePriceProvider.new(
          url: fallback_url || FALLBACK_PRICE_FEED_URL,
          source: "fallback",
          http: http
        )
      }
    end

    # Wires the hard-coded (or overridden) feeds to a disposable local cache.
    def create_cached_live_price_feed(currencies:, http: nil, clock: nil, cache_seconds: nil,
                                      primary_url: nil, fallback_url: nil, primary_timeout_ms: nil)
      providers = create_live_price_feed_providers(
        http: http,
        primary_url: primary_url,
        fallback_url: fallback_url,
        primary_timeout_ms: primary_timeout_ms
      )
      CachedPriceFeed.new(
        currencies: currencies,
        primary: providers.fetch(:primary),
        fallback: providers.fetch(:fallback),
        cache_seconds: cache_seconds,
        clock: clock
      )
    end

    # Host-side helper (the Ruby analogue of the node service's env reader):
    # returns non-empty URL overrides from the well-known env var names.
    def read_price_feed_url_overrides(env = ENV)
      {
        primary_url: presence(env[PRICE_FEED_PRIMARY_URL_ENV]),
        fallback_url: presence(env[PRICE_FEED_FALLBACK_URL_ENV])
      }
    end

    def presence(value)
      text = value.to_s.strip
      text.empty? ? nil : text
    end

    # Default HTTP transport on stdlib Net::HTTP. Injectable replacements must
    # be callable as call(url, headers, timeout_ms) and return a Hash with
    # :status (Integer) and :body (String).
    def default_http_get(url, headers, timeout_ms)
      uri = URI.parse(url)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      unless timeout_ms.nil?
        seconds = timeout_ms / 1000.0
        http.open_timeout = seconds
        http.read_timeout = seconds
        http.write_timeout = seconds if http.respond_to?(:write_timeout=)
      end
      request = Net::HTTP::Get.new(uri.request_uri)
      headers.each { |key, value| request[key] = value }
      response = http.start { |connection| connection.request(request) }
      { status: Integer(response.code), body: response.body.to_s }
    end

    # Serves the fixed static_mock table (same semantics as JS
    # StaticPriceProvider). Satisfies the openreceive-server price_provider
    # contract via btc_fiat_price(currency).
    class StaticPriceProvider
      def source
        STATIC_PRICE_SOURCE_ID
      end

      def btc_fiat_rates(currencies)
        rates = {}
        currencies.each do |currency|
          rates[Rates.normalize_fiat_currency(currency)] = Rates.static_btc_fiat_price(currency)
        end
        { "bitcoin" => rates }
      end

      def btc_fiat_rates_with_source(currencies)
        { "source" => source, "rates" => btc_fiat_rates(currencies) }
      end

      def btc_fiat_price(currency)
        Rates.static_btc_fiat_price(currency)
      end
    end

    # Fetches a Simple Price compatible HTTP endpoint and selects the
    # requested fiat currencies. When timeout_ms is set, a slow endpoint fails
    # within that window so the caller can fall through to another feed.
    class HttpSimplePriceProvider
      attr_reader :url, :source, :timeout_ms

      def initialize(url:, source:, http: nil, timeout_ms: nil)
        @url = url
        @source = source
        @http = http
        @timeout_ms = timeout_ms
      end

      def btc_fiat_rates(currencies)
        Rates.parse_simple_price_response(fetch_json, currencies)
      end

      # Returns every well-formed currency the endpoint carries, for caching
      # the whole feed in one read.
      def all_btc_fiat_rates
        Rates.parse_available_simple_price_response(fetch_json)
      end

      private

      def fetch_json
        response = perform_request
        status = response[:status] || response["status"]
        body = response[:body] || response["body"]
        unless (200..299).cover?(status)
          raise PriceFeedError, "price source #{@source} returned HTTP #{status}"
        end
        JSON.parse(body.to_s)
      end

      def perform_request
        transport = @http || Rates.method(:default_http_get)
        transport.call(@url, { "accept" => "application/json" }, @timeout_ms)
      rescue Net::OpenTimeout, Net::ReadTimeout, Timeout::Error => e
        raise PriceFeedError, timeout_message(e)
      rescue PriceFeedError
        raise
      rescue StandardError => e
        raise PriceFeedError, "price source #{@source} request failed: #{e.message}"
      end

      def timeout_message(error)
        return "price source #{@source} did not respond within #{@timeout_ms}ms" unless @timeout_ms.nil?
        "price source #{@source} request failed: #{error.message}"
      end
    end

    # Serves BTC fiat rates from a disposable process-local cache, refreshing
    # from the primary feed first and the fallback second. Port of the JS
    # CachedPriceFeed state machine: fresh entries are served for
    # cache_seconds; a refresh failure fails closed for cache_seconds; a
    # concurrent in-flight refresh serves the stale entry only while it is
    # younger than the invoice quote TTL. Satisfies the openreceive-server
    # price_provider contract via btc_fiat_price(currency).
    class CachedPriceFeed
      # Representative source for the plain source reader; the true origin is
      # reported per-call by btc_fiat_rates_with_source.
      attr_reader :source

      def initialize(currencies:, primary:, fallback:, cache_seconds: nil, clock: nil)
        raise ArgumentError, "CachedPriceFeed requires at least one currency" if currencies.empty?
        cache_seconds ||= PRICE_FEED_CACHE_SECONDS
        unless cache_seconds.is_a?(Integer) && cache_seconds.positive?
          raise ArgumentError, "CachedPriceFeed cache_seconds must be a positive integer"
        end
        # A cache window wider than the quote TTL would let a read be reported
        # as fresh that is already too old to price an invoice.
        if cache_seconds > INVOICE_QUOTE_TTL_SECONDS
          raise ArgumentError,
                "CachedPriceFeed cache_seconds must not exceed the #{INVOICE_QUOTE_TTL_SECONDS}s invoice quote TTL"
        end
        @currencies = currencies.map(&:to_s).freeze
        @primary = primary
        @fallback = fallback
        @cache_seconds = cache_seconds
        @clock = clock || -> { Time.now.to_i }
        @source = "primary"
        @mutex = Mutex.new
        @refresh_done = ConditionVariable.new
        @state = nil
        @in_flight = nil
      end

      def btc_fiat_rates(currencies)
        btc_fiat_rates_with_source(currencies).fetch("rates")
      end

      def btc_fiat_rates_with_source(currencies)
        now = @clock.call
        claim = read_or_claim_refresh(now)
        entry =
          case claim.fetch(:status)
          when :served then claim.fetch(:entry)
          when :pending then await_refresh(claim.fetch(:pending))
          else tracked_refresh(now, claim.fetch(:previous_entry), claim.fetch(:pending))
          end
        {
          "source" => entry.fetch("source"),
          "rates" => Rates.parse_simple_price_response(entry.fetch("rates"), currencies)
        }
      end

      # The openreceive-server price_provider contract: one decimal price
      # string for one uppercase ISO 4217 currency.
      def btc_fiat_price(currency)
        btc_fiat_rates([currency]).fetch("bitcoin").fetch(Rates.normalize_fiat_currency(currency))
      end

      # Forces a live refresh, ignoring the cache, for explicit operational
      # probes. Raises if both feeds fail. Tolerant of an upstream that drops
      # an individual currency (pass no currencies to get everything cached).
      def health_check(currencies = nil)
        now = @clock.call
        pending = { "owner" => Thread.current, "done" => false }
        previous_entry = @mutex.synchronize do
          @in_flight = pending
          @state && @state["entry"]
        end
        entry = tracked_refresh(now, previous_entry, pending)
        rates =
          if currencies.nil? || currencies.empty?
            entry.fetch("rates")
          else
            Rates.parse_simple_price_response(entry.fetch("rates"), currencies)
          end
        { "source" => entry.fetch("source"), "rates" => rates }
      end

      private

      def read_or_claim_refresh(now)
        @mutex.synchronize do
          state = @state
          entry = state && state["entry"]

          entry_age = entry && stamp_age(entry.fetch("fetched_at"), now)
          if entry_age && entry_age < @cache_seconds
            return { status: :served, entry: entry }
          end

          # Stale-while-revalidate is bounded by the invoice quote TTL: a rate
          # observed longer ago than a quote may live must never price a new
          # invoice — fail closed instead of serving it.
          quotable = entry if entry_age && entry_age < INVOICE_QUOTE_TTL_SECONDS

          if state && recent?(state["refresh_failed_at"], now)
            # One failed refresh must not hard-down quoting for the whole
            # backoff while a still-quotable observation is in hand.
            return { status: :served, entry: quotable } unless quotable.nil?
            message = "price feed refresh already failed within #{@cache_seconds}s"
            message += ": #{state["refresh_error"]}" unless state["refresh_error"].to_s.empty?
            raise PriceFeedError, message
          end

          if state && recent?(state["refresh_started_at"], now)
            return { status: :served, entry: quotable } unless quotable.nil?
            # Cold cache: join the refresh already running in this process
            # rather than failing every concurrent caller but the one that
            # claimed it. The claiming thread itself cannot wait on its own
            # refresh, so a re-entrant read still fails closed.
            pending = @in_flight
            if !pending.nil? && !pending["owner"].equal?(Thread.current)
              return { status: :pending, pending: pending }
            end
            raise PriceFeedError, "price feed refresh already started within #{@cache_seconds}s"
          end

          claimed = { "refresh_started_at" => now }
          claimed["entry"] = entry unless entry.nil?
          @state = claimed
          pending = { "owner" => Thread.current, "done" => false }
          @in_flight = pending
          { status: :claimed, previous_entry: entry, pending: pending }
        end
      end

      def recent?(timestamp, now)
        age = stamp_age(timestamp, now)
        !age.nil? && age < @cache_seconds
      end

      # Age of a cache stamp, or nil when the stamp is unusable because it sits
      # beyond the clock-skew tolerance in the future (mirrors the JS cache).
      def stamp_age(timestamp, now)
        return nil if timestamp.nil?

        age = now - timestamp
        return nil if age < -PRICE_FEED_CLOCK_SKEW_SECONDS

        age.negative? ? 0 : age
      end

      def tracked_refresh(now, previous_entry, pending)
        entry = refresh(now, previous_entry)
        settle(pending, entry, nil)
        entry
      rescue StandardError => e
        settle(pending, nil, e)
        raise
      end

      def settle(pending, entry, error)
        @mutex.synchronize do
          pending["entry"] = entry
          pending["error"] = error
          pending["done"] = true
          @in_flight = nil if @in_flight.equal?(pending)
          @refresh_done.broadcast
        end
      end

      def await_refresh(pending)
        @mutex.synchronize do
          @refresh_done.wait(@mutex) until pending["done"]
        end
        error = pending["error"]
        raise error unless error.nil?
        pending["entry"]
      end

      def refresh(now, previous_entry)
        failures = []
        [@primary, @fallback].each do |provider|
          begin
            rates = fetch_provider_rates(provider)
            entry = { "rates" => rates, "source" => provider.source, "fetched_at" => now }
            @mutex.synchronize { @state = { "entry" => entry } }
            return entry
          rescue StandardError => e
            failures << "#{provider.source}: #{e.message}"
          end
        end

        message = "all price feeds failed: #{failures.join("; ")}"
        @mutex.synchronize do
          failed = {
            "refresh_started_at" => now,
            "refresh_failed_at" => now,
            "refresh_error" => message
          }
          failed["entry"] = previous_entry unless previous_entry.nil?
          @state = failed
        end
        raise PriceFeedError, message
      end

      # Cache the whole feed when the provider can serve it tolerantly;
      # otherwise request just the configured currencies.
      def fetch_provider_rates(provider)
        return provider.all_btc_fiat_rates if provider.respond_to?(:all_btc_fiat_rates)
        provider.btc_fiat_rates(@currencies)
      end
    end
  end
end
