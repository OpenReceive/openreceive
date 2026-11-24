# frozen_string_literal: true

require "minitest/autorun"
require "openreceive/server"
require "openssl"
require "json"
require "uri"

# Mirrors tests/fixedfloat.test.mjs, fixedfloat-rates.test.mjs,
# swap-provider-failover.test.mjs, and the swap parts of service.ts — the same
# provider payloads must produce the same orders, quotes, and wire options in
# both engines. Change both together.

SWAP = OpenReceive::Server::Swap
RATES = SWAP::FixedFloatRates

NOW = 1_700_000_000
API_KEY = "test-api-key"
API_SECRET = "test-api-secret"
BASE_URL = "https://ff.example"
BOLT11 = "lnbc200u1testshadowinvoice"
TRX_ADDRESS = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"
ETH_ADDRESS = "0x2222222222222222222222222222222222222222"

SAMPLE_CCIES = [
  { "code" => "USDTTRC", "coin" => "USDT", "network" => "TRC20", "recv" => true, "send" => true },
  { "code" => "SOL", "coin" => "SOL", "network" => "SOL", "recv" => true, "send" => true },
  { "code" => "BTCLN", "coin" => "BTC", "network" => "LIGHTNING", "recv" => false, "send" => true }
].freeze

# 20_000_000 msats = 20_000 sats = 0.0002 BTC (the string /create must receive).
INVOICE_AMOUNT_MSATS = 20_000_000

CREATE_DATA = {
  "id" => "ORDER1",
  "token" => "TOKEN1",
  "status" => "NEW",
  "from" => { "code" => "USDTTRC", "amount" => "12.5", "address" => TRX_ADDRESS,
              "tag" => "1234", "usd" => "12.60" },
  "to" => { "code" => "BTCLN", "amount" => "0.0002", "usd" => "12.40" },
  "time" => { "expiration" => NOW + 550 }
}.freeze

BASE_ORDER = {
  "provider" => "fixedfloat",
  "provider_order_id" => "ORDER1",
  "provider_token" => "TOKEN1",
  "pay_in_asset" => "USDT_TRON",
  "deposit_address" => TRX_ADDRESS,
  "deposit_amount" => "12.5",
  "expires_at" => NOW + 550,
  "state" => "awaiting_deposit"
}.freeze

SAMPLE_XML = <<~XML
  <?xml version="1.0"?>
  <rates>
    <item>
      <from>USDTTRC</from>
      <to>BTCLN</to>
      <in>315</in>
      <out>0.005</out>
      <amount>1170121.61</amount>
      <tofee>0.00000001 BTC</tofee>
      <minamount>10</minamount>
      <maxamount>11340</maxamount>
    </item>
    <item>
      <from>ETH</from>
      <to>BTCLN</to>
      <in>1</in>
      <out>0.05</out>
      <amount>10</amount>
      <minamount>0.01 ETH</minamount>
      <maxamount>2 ETH</maxamount>
    </item>
  </rates>
XML

FAILOVER_RATES_XML = <<~XML
  <?xml version="1.0"?>
  <rates>
    <item>
      <from>USDTTRC</from>
      <to>BTCLN</to>
      <in>315</in>
      <out>0.005</out>
      <amount>1000</amount>
      <minamount>10</minamount>
      <maxamount>11340</maxamount>
    </item>
    <item>
      <from>SOL</from>
      <to>BTCLN</to>
      <in>1</in>
      <out>0.001</out>
      <amount>100</amount>
      <minamount>0.01</minamount>
      <maxamount>50</maxamount>
    </item>
    <item>
      <from>DOGE</from>
      <to>BTC</to>
      <in>1</in>
      <out>0.000001</out>
      <amount>100000</amount>
      <minamount>10</minamount>
      <maxamount>500000</maxamount>
    </item>
    <item>
      <from>ETH</from>
      <to>USDT</to>
      <in>1</in>
      <out>3000</out>
      <amount>10</amount>
      <minamount>0.01</minamount>
      <maxamount>5</maxamount>
    </item>
  </rates>
XML

# `routes` maps an /api/v2 path ("create", "order", ...) or "rates/fixed.xml"
# to either a data payload (wrapped in a {code: 0} envelope) or a lambda
# returning a raw {status:, body:} response. Every call is recorded with its
# parsed body and headers so tests can pin the outbound request contract.
def make_transport(routes, calls)
  lambda do |method:, url:, headers:, body: nil, timeout_ms: nil|
    path = URI.parse(url).path.sub(%r{\A/api/v2/}, "").sub(%r{\A/}, "")
    calls << {
      path: path, method: method, headers: headers, url: url,
      body: body.nil? ? nil : JSON.parse(body), raw_body: body
    }
    route = routes[path]
    raise "unexpected FixedFloat call: #{url}" if route.nil?
    next route.call if route.respond_to?(:call)
    if path.end_with?(".xml")
      { status: 200, body: route }
    else
      { status: 200, body: JSON.generate("code" => 0, "msg" => "OK", "data" => route) }
    end
  end
end

def make_provider(routes, options = {})
  calls = []
  provider = SWAP::FixedFloatProvider.new(
    key: API_KEY,
    secret: API_SECRET,
    base_url: BASE_URL,
    http: make_transport(routes, calls),
    now: -> { NOW },
    **options
  )
  [provider, calls]
end

def status_for(order_data, base_order = BASE_ORDER)
  provider, = make_provider("order" => order_data)
  provider.get_status(base_order)
end

class FixedFloatRatesTest < Minitest::Test
  def test_parse_xml_indexes_pairs_and_strips_currency_suffixes
    pairs = RATES.parse_xml(SAMPLE_XML)
    assert_equal "ETH:BTCLN,USDTTRC:BTCLN", pairs.keys.sort.join(",")
    assert_equal "10", pairs.dig("USDTTRC:BTCLN", "minamount")
    assert_equal "0.01", pairs.dig("ETH:BTCLN", "minamount")
    assert_equal "2", pairs.dig("ETH:BTCLN", "maxamount")
    assert_equal "0.00000001 BTC", pairs.dig("USDTTRC:BTCLN", "tofee")
  end

  def test_retains_only_lightning_payout_pairs_and_selected_keys
    parsed = RATES.parse_xml(FAILOVER_RATES_XML)
    assert_equal 4, parsed.length
    lightning_only = RATES.retain_lightning_payout_pairs(parsed)
    assert_equal %w[SOL:BTCLN USDTTRC:BTCLN], lightning_only.keys.sort

    fetched = RATES.fetch_index(
      base_url: BASE_URL,
      http: ->(**_request) { { status: 200, body: FAILOVER_RATES_XML } },
      now: -> { 1_000 }
    )
    assert_equal %w[SOL:BTCLN USDTTRC:BTCLN], fetched.fetch("pairs").keys.sort

    trimmed = RATES.retain_pairs_for_keys(fetched, ["USDTTRC:BTCLN", "MISSING:BTCLN"])
    assert_equal %w[USDTTRC:BTCLN], trimmed.fetch("pairs").keys.sort
  end

  def test_quote_pay_amount_uses_exact_decimal_math_and_folds_btc_tofee
    pair = RATES.parse_xml(SAMPLE_XML).fetch("USDTTRC:BTCLN")
    # 0.005 BTC (= 500_000 sats) at 315 USDT / 0.005 BTC = 315 USDT.
    assert_equal "315.00063",
                 RATES.quote_pay_amount(pair: pair, invoice_amount_msats: 500_000_000)
    # Without the 1-sat tofee the same invoice is exactly 315.
    assert_equal "315",
                 RATES.quote_pay_amount(pair: pair.reject { |key, _| key == "tofee" },
                                        invoice_amount_msats: 500_000_000)
  end

  def test_invoice_limits_map_from_side_min_max_into_invoice_msats
    limits = RATES.invoice_limits(RATES.parse_xml(SAMPLE_XML).fetch("USDTTRC:BTCLN"))
    assert_equal "10", limits.fetch("minimum_pay_amount")
    assert_equal "11340", limits.fetch("maximum_pay_amount")
    assert_equal 15_874_000, limits.fetch("minimum_invoice_amount_msats")
    assert_equal 18_000_000_000, limits.fetch("maximum_invoice_amount_msats")
  end

  def test_invoice_limits_handle_out_amounts_padded_past_8_decimals
    # Live FixedFloat XML pads BTC amounts like 0.028314000000 (12 fractional
    # digits); a float/8-dp path silently dropped invoice-side limits.
    pairs = RATES.parse_xml(<<~XML)
      <?xml version="1.0"?>
      <rates>
        <item>
          <from>ETH</from>
          <to>BTCLN</to>
          <in>1</in>
          <out>0.028314000000</out>
          <amount>207.22797276</amount>
          <tofee>0.0000016000 BTCLN</tofee>
          <minamount>0.0083927593</minamount>
          <maxamount>6.2933949000</maxamount>
        </item>
      </rates>
    XML
    pair = pairs.fetch("ETH:BTCLN")
    limits = RATES.invoice_limits(pair)
    assert_equal "0.0083927593", limits.fetch("minimum_pay_amount")
    # Exact: ceil(0.0083927593 × 0.028314000000 × 1e8 / 1) = 23,764 sats.
    assert_equal 23_764_000, limits.fetch("minimum_invoice_amount_msats")
    # The 10-decimal "0.0000016000 BTCLN" network fee (160 sats) is reduced
    # with ceil rounding and folded in: (3185 + 160) / 2,831,400 = 0.0011814.
    assert_equal "0.0011814", RATES.quote_pay_amount(pair: pair, invoice_amount_msats: 3_185_000)
    assert_operator 3_185_000, :<, limits.fetch("minimum_invoice_amount_msats")
  end

  def test_compare_decimal_amounts_orders_positive_decimals_without_floats
    assert_equal(-1, RATES.compare_decimal_amounts("0.00112489", "0.0083927593"))
    assert_equal 0, RATES.compare_decimal_amounts("10", "10.000")
    assert_equal 1, RATES.compare_decimal_amounts("2", "1.5")
    assert_nil RATES.compare_decimal_amounts("nope", "1")
  end

  def test_rates_cache_is_reused_inside_one_process
    fetches = 0
    cache = SWAP::TransientSwapCache.new(-> { 1_000 })
    fetch = lambda do
      fetches += 1
      RATES.fetch_index(
        base_url: BASE_URL,
        http: ->(**_request) { { status: 200, body: SAMPLE_XML } },
        now: -> { 1_000 }
      )
    end
    resolve = lambda do
      cache.resolve(
        RATES.rates_meta_key("fixedfloat", "fixed"),
        refresh_seconds: 15, max_stale_seconds: 15, serve_stale_on_failure: false,
        fetch: fetch,
        serialize: ->(index) { RATES.serialize_index(index) },
        deserialize: ->(value) { RATES.deserialize_index(value) }
      )
    end
    first = resolve.call
    second = resolve.call
    assert_equal 1, fetches
    assert_equal "315", first.dig("pairs", "USDTTRC:BTCLN", "in")
    assert_equal "315", second.dig("pairs", "USDTTRC:BTCLN", "in")
  end

  def test_rates_cache_refresh_failure_does_not_serve_stale_rates
    now = 1_000
    should_fail = false
    cache = SWAP::TransientSwapCache.new(-> { now })
    fetch = lambda do
      raise "rates down" if should_fail
      RATES.fetch_index(
        base_url: BASE_URL,
        http: ->(**_request) { { status: 200, body: SAMPLE_XML } },
        now: -> { now }
      )
    end
    resolve = lambda do
      cache.resolve(
        RATES.rates_meta_key("fixedfloat", "fixed"),
        refresh_seconds: 15, max_stale_seconds: 15, serve_stale_on_failure: false,
        fetch: fetch,
        serialize: ->(index) { RATES.serialize_index(index) },
        deserialize: ->(value) { RATES.deserialize_index(value) }
      )
    end
    resolve.call
    now = 1_020
    should_fail = true
    error = assert_raises(RuntimeError) { resolve.call }
    assert_match(/rates down/, error.message)
  end
end

class TransientSwapCacheConcurrencyTest < Minitest::Test
  def resolve(cache, key, fetch)
    cache.resolve(
      key,
      refresh_seconds: 15, max_stale_seconds: 15, serve_stale_on_failure: false,
      fetch: fetch,
      serialize: ->(value) { value },
      deserialize: ->(value) { value }
    )
  end

  def test_a_slow_fetch_on_one_key_does_not_block_other_keys
    cache = SWAP::TransientSwapCache.new(-> { 1_000 })
    slow_started = Queue.new
    release_slow = Queue.new
    slow = Thread.new do
      resolve(cache, "slow-key", lambda do
        slow_started << true
        release_slow.pop
        "slow-value"
      end)
    end
    slow_started.pop
    fast = Thread.new { resolve(cache, "fast-key", -> { "fast-value" }) }
    refute_nil fast.join(5), "fetch on another key blocked behind the slow fetch"
    assert_equal "fast-value", fast.value
    release_slow << true
    assert_equal "slow-value", slow.value
  end

  def test_concurrent_fetches_of_the_same_key_share_one_fetch
    cache = SWAP::TransientSwapCache.new(-> { 1_000 })
    fetches = 0
    started = Queue.new
    release = Queue.new
    fetch = lambda do
      fetches += 1
      started << true
      release.pop
      "shared-value"
    end
    first = Thread.new { resolve(cache, "shared-key", fetch) }
    started.pop
    second = Thread.new { resolve(cache, "shared-key", fetch) }
    sleep 0.05
    release << true
    assert_equal "shared-value", first.value
    assert_equal "shared-value", second.value
    assert_equal 1, fetches
  end

  def test_a_joined_fetch_failure_raises_in_every_waiter
    cache = SWAP::TransientSwapCache.new(-> { 1_000 })
    started = Queue.new
    release = Queue.new
    fetch = lambda do
      started << true
      release.pop
      raise "catalog down"
    end
    first = Thread.new { resolve(cache, "failing-key", fetch) }
    first.report_on_exception = false
    started.pop
    second = Thread.new { resolve(cache, "failing-key", fetch) }
    second.report_on_exception = false
    sleep 0.05
    release << true
    error = assert_raises(RuntimeError) { first.value }
    assert_match(/catalog down/, error.message)
    error = assert_raises(RuntimeError) { second.value }
    assert_match(/catalog down/, error.message)
  end
end

class FixedFloatProviderTest < Minitest::Test
  def test_create_swap_sends_a_signed_fixed_rate_create_request_and_maps_the_order
    provider, calls = make_provider("ccies" => SAMPLE_CCIES, "create" => CREATE_DATA)
    order = provider.create_swap(
      pay_in_asset: "USDT_TRON", bolt11: BOLT11, invoice_amount_msats: INVOICE_AMOUNT_MSATS
    )

    # /ccies resolves the pair, then /create places the order. from/to.usd were
    # present, so no /price fee backfill happens.
    assert_equal %w[ccies create], calls.map { |call| call[:path] }
    create = calls[1]
    assert_equal "POST", create[:method]
    assert_equal(
      {
        "type" => "fixed", "fromCcy" => "USDTTRC", "toCcy" => "BTCLN",
        "direction" => "to", "amount" => "0.0002", "toAddress" => BOLT11
      },
      create[:body]
    )
    assert_equal API_KEY, create[:headers].fetch("X-API-KEY")
    assert_equal OpenSSL::HMAC.hexdigest("SHA256", API_SECRET, create[:raw_body]),
                 create[:headers].fetch("X-API-SIGN")

    assert_equal "fixedfloat", order.fetch("provider")
    assert_equal "ORDER1", order.fetch("provider_order_id")
    assert_equal "TOKEN1", order.fetch("provider_token")
    assert_equal "USDT_TRON", order.fetch("pay_in_asset")
    assert_equal TRX_ADDRESS, order.fetch("deposit_address")
    assert_equal "1234", order.fetch("deposit_memo")
    assert_equal "12.5", order.fetch("deposit_amount")
    assert_equal NOW + 550, order.fetch("expires_at")
    assert_equal "awaiting_deposit", order.fetch("state")
    assert_equal({ "currency" => "USD", "pay_in_fiat" => "12.60", "payout_fiat" => "12.40" },
                 order.fetch("fee"))
    assert_equal CREATE_DATA, order.fetch("raw")
  end

  # No invented deadline: the provider states the expiry. A create body without
  # one is a provider contract break, and fabricating a 10-minute window would
  # hand the payer a deadline the provider never agreed to.
  def test_create_swap_fails_when_the_order_omits_expiration
    provider, = make_provider(
      "ccies" => SAMPLE_CCIES, "create" => CREATE_DATA.merge("time" => {})
    )
    error = assert_raises(RuntimeError) do
      provider.create_swap(
        pay_in_asset: "USDT_TRON", bolt11: BOLT11, invoice_amount_msats: INVOICE_AMOUNT_MSATS
      )
    end
    assert_equal "FixedFloat order is missing time.expiration.", error.message
  end

  def test_create_swap_backfills_the_fee_from_price_when_create_omits_usd_values
    create_data = CREATE_DATA.merge(
      "from" => { "code" => "USDTTRC", "amount" => "12.5", "address" => TRX_ADDRESS },
      "to" => { "code" => "BTCLN", "amount" => "0.0002" }
    )
    provider, calls = make_provider(
      "ccies" => SAMPLE_CCIES,
      "create" => create_data,
      "price" => { "from" => { "usd" => "12.61" }, "to" => { "usd" => "12.41" } }
    )
    order = provider.create_swap(
      pay_in_asset: "USDT_TRON", bolt11: BOLT11, invoice_amount_msats: INVOICE_AMOUNT_MSATS
    )
    assert_equal %w[ccies create price], calls.map { |call| call[:path] }
    assert_equal(
      {
        "type" => "fixed", "fromCcy" => "USDTTRC", "toCcy" => "BTCLN",
        "direction" => "to", "amount" => "0.0002"
      },
      calls[2][:body]
    )
    assert_equal({ "currency" => "USD", "pay_in_fiat" => "12.61", "payout_fiat" => "12.41" },
                 order.fetch("fee"))
  end

  def test_create_swap_leaves_the_fee_off_when_the_price_backfill_fails
    create_data = CREATE_DATA.merge(
      "from" => { "code" => "USDTTRC", "amount" => "12.5", "address" => TRX_ADDRESS },
      "to" => { "code" => "BTCLN", "amount" => "0.0002" }
    )
    provider, = make_provider(
      "ccies" => SAMPLE_CCIES,
      "create" => create_data,
      "price" => -> { { status: 200, body: JSON.generate("code" => 1, "msg" => "Unavailable") } }
    )
    order = provider.create_swap(
      pay_in_asset: "USDT_TRON", bolt11: BOLT11, invoice_amount_msats: INVOICE_AMOUNT_MSATS
    )
    assert_nil order["fee"]
    assert_equal "awaiting_deposit", order.fetch("state")
  end

  def test_create_swap_trusts_the_providers_quoted_payout_amount
    provider, = make_provider(
      "ccies" => SAMPLE_CCIES,
      "create" => CREATE_DATA.merge("to" => { "code" => "BTCLN", "amount" => "0.0003" })
    )
    order = provider.create_swap(
      pay_in_asset: "USDT_TRON", bolt11: BOLT11, invoice_amount_msats: INVOICE_AMOUNT_MSATS
    )
    assert_equal "awaiting_deposit", order.fetch("state")
  end

  def test_create_swap_stores_the_deposit_address_the_provider_sent
    provider, = make_provider(
      "ccies" => SAMPLE_CCIES,
      "create" => CREATE_DATA.merge(
        "from" => { "code" => "USDTTRC", "amount" => "12.5", "address" => ETH_ADDRESS }
      )
    )
    order = provider.create_swap(
      pay_in_asset: "USDT_TRON", bolt11: BOLT11, invoice_amount_msats: INVOICE_AMOUNT_MSATS
    )
    assert_equal ETH_ADDRESS, order.fetch("deposit_address")
  end

  def test_get_status_maps_every_recognized_status_to_its_provider_state
    {
      "NEW" => "awaiting_deposit",
      "PENDING" => "confirming",
      "EXCHANGE" => "exchanging",
      "WITHDRAW" => "paying_invoice",
      "DONE" => "completed",
      "done" => "completed",
      "EXPIRED" => "expired",
      "FAILED" => "failed"
    }.each do |provider_status, state|
      # Sparse status payload: id/token/address/amount come from the prior order.
      order = status_for("status" => provider_status)
      assert_equal state, order.fetch("state"), provider_status
      assert_equal TRX_ADDRESS, order.fetch("deposit_address"), provider_status
      assert_equal "12.5", order.fetch("deposit_amount"), provider_status
      assert_equal NOW + 550, order.fetch("expires_at"), provider_status
      assert_nil order["attention"], provider_status
    end
  end

  def test_get_status_sends_the_stored_reference_and_token
    provider, calls = make_provider("order" => { "status" => "PENDING" })
    provider.get_status(BASE_ORDER)
    assert_equal({ "id" => "ORDER1", "token" => "TOKEN1" }, calls[0][:body])
    assert_equal OpenSSL::HMAC.hexdigest("SHA256", API_SECRET, calls[0][:raw_body]),
                 calls[0][:headers].fetch("X-API-SIGN")
  end

  def test_get_status_labels_unrecognized_statuses
    # An unknown status is not a provider-reported emergency — it gets its own
    # attention reason so operators land on the right runbook section.
    order = status_for("status" => "SOMETHING_NEW")
    assert_equal "attention", order.fetch("state")
    assert_equal true, order.fetch("attention")
    assert_equal "provider_status_unrecognized", order.fetch("attention_reason")
  end

  def test_get_status_maps_done_with_a_refund_transaction_to_refunded
    order = status_for(
      { "status" => "DONE", "back" => { "amount" => "12.3", "tx" => { "id" => "refund-tx-1" } } },
      BASE_ORDER.merge("state" => "refund_pending", "refund_reason" => "underpaid")
    )
    assert_equal "refunded", order.fetch("state")
    assert_equal "refund-tx-1", order.fetch("refund_tx_id")
    assert_equal "12.3", order.fetch("refund_amount")
    # The refund reason established earlier in the lifecycle is retained.
    assert_equal "underpaid", order.fetch("refund_reason")
  end

  def test_get_status_maps_emergency_responses_onto_refund_and_attention_paths
    [
      { name: "underpaid, no choice yet", emergency: { "status" => ["LESS"] },
        expected: { "state" => "refund_required", "refund_reason" => "underpaid" } },
      { name: "late deposit, no choice yet", emergency: { "status" => ["EXPIRED"] },
        expected: { "state" => "refund_required", "refund_reason" => "late_deposit" } },
      { name: "underpaid and late", emergency: { "status" => %w[LESS EXPIRED] },
        expected: { "state" => "refund_required", "refund_reason" => "underpaid_and_late" } },
      { name: "refund chosen, not yet paid out",
        emergency: { "choice" => "REFUND", "status" => ["EXPIRED"] },
        expected: { "state" => "refund_pending", "refund_reason" => "late_deposit" } },
      { name: "exchange chosen", emergency: { "choice" => "EXCHANGE", "status" => ["LESS"] },
        expected: { "state" => "attention", "attention_reason" => "provider_reported_emergency" } },
      # The provider refunds an overpay in full — same self-serve path as an
      # underpay, not a support ticket.
      { name: "overpaid", emergency: { "status" => %w[MORE LIMIT] },
        expected: { "state" => "refund_required", "refund_reason" => "overpaid" } },
      { name: "overpaid and late", emergency: { "status" => %w[MORE EXPIRED] },
        expected: { "state" => "refund_required", "refund_reason" => "overpaid_and_late" } }
    ].each do |kase|
      order = status_for("status" => "EMERGENCY", "emergency" => kase[:emergency])
      expected = kase[:expected]
      assert_equal expected["state"], order.fetch("state"), kase[:name]
      if expected["refund_reason"].nil?
        assert_nil order["refund_reason"], kase[:name]
      else
        assert_equal expected["refund_reason"], order["refund_reason"], kase[:name]
      end
      if expected["attention_reason"].nil?
        assert_nil order["attention_reason"], kase[:name]
      else
        assert_equal expected["attention_reason"], order["attention_reason"], kase[:name]
      end
      if expected["state"] == "attention"
        assert_equal true, order["attention"], kase[:name]
      else
        assert_nil order["attention"], kase[:name]
      end
    end
  end

  def test_get_status_maps_a_paid_out_emergency_refund_to_refunded
    order = status_for(
      "status" => "EMERGENCY",
      "emergency" => { "choice" => "REFUND", "status" => ["LESS"] },
      "back" => { "amount" => "11.9", "tx" => { "id" => "refund-tx-2" } }
    )
    assert_equal "refunded", order.fetch("state")
    assert_equal "underpaid", order.fetch("refund_reason")
    assert_equal "refund-tx-2", order.fetch("refund_tx_id")
    assert_equal "11.9", order.fetch("refund_amount")
  end

  def test_get_status_surfaces_repeat_deposits_received_amounts_and_tx_ids
    order = status_for(
      "status" => "EMERGENCY",
      "emergency" => { "status" => ["LESS"], "repeat" => "1" },
      "from" => { "tx" => { "id" => "deposit-tx-1", "amount" => "6.25" } }
    )
    assert_equal "refund_required", order.fetch("state")
    assert_equal true, order.fetch("emergency_repeat")
    assert_equal "deposit-tx-1", order.fetch("deposit_tx_id")
    assert_equal "6.25", order.fetch("deposit_received_amount")
  end

  def test_request_refund_posts_the_refund_choice_with_the_refund_address
    provider, calls = make_provider("emergency" => {})
    provider.request_refund(BASE_ORDER, TRX_ADDRESS)
    assert_equal 1, calls.length
    assert_equal "emergency", calls[0][:path]
    assert_equal(
      { "id" => "ORDER1", "token" => "TOKEN1", "choice" => "REFUND", "address" => TRX_ADDRESS },
      calls[0][:body]
    )
    assert_equal OpenSSL::HMAC.hexdigest("SHA256", API_SECRET, calls[0][:raw_body]),
                 calls[0][:headers].fetch("X-API-SIGN")
  end

  def test_http_failures_surface_as_api_errors_with_status_and_message
    provider, = make_provider(
      "order" => -> { { status: 500, body: JSON.generate("code" => 1, "msg" => "Internal error") } }
    )
    error = assert_raises(SWAP::FixedFloatApiError) { provider.get_status(BASE_ORDER) }
    assert_equal "http", error.kind
    assert_equal 500, error.http_status
    assert_equal "order", error.path
    assert_equal "FixedFloat order failed with HTTP 500: Internal error", error.message
    # Provider failures must never leak an HTTP mapping to the wire layer:
    # the request handler duck-types #status/#code, so the error exposes neither.
    refute_respond_to error, :status
    refute_respond_to error, :code
  end

  def test_api_envelope_errors_surface_the_fixedfloat_message
    provider, = make_provider(
      "order" => -> { { status: 200, body: JSON.generate("code" => 1, "msg" => "Invalid order") } }
    )
    error = assert_raises(SWAP::FixedFloatApiError) { provider.get_status(BASE_ORDER) }
    assert_equal "api", error.kind
    assert_equal 1, error.fixedfloat_code
    assert_equal "Invalid order", error.message
  end

  def test_invalid_json_network_and_timeout_failures_map_to_their_error_kinds
    invalid_json, = make_provider("order" => -> { { status: 200, body: "<html>oops</html>" } })
    error = assert_raises(SWAP::FixedFloatApiError) { invalid_json.get_status(BASE_ORDER) }
    assert_equal "invalid_json", error.kind

    network, = make_provider("order" => -> { raise "connect ECONNREFUSED" })
    error = assert_raises(SWAP::FixedFloatApiError) { network.get_status(BASE_ORDER) }
    assert_equal "network", error.kind

    timeout, = make_provider("order" => -> { raise Net::ReadTimeout })
    error = assert_raises(SWAP::FixedFloatApiError) { timeout.get_status(BASE_ORDER) }
    assert_equal "timeout", error.kind
    assert_equal "FixedFloat order request timed out.", error.message
  end

  def test_http_429_marks_the_weight_budget_rate_limited
    provider, = make_provider(
      "order" => -> { { status: 429, body: JSON.generate("code" => 1, "msg" => "Too many requests") } }
    )
    reserved = []
    rate_limited = 0
    budget = Object.new
    budget.define_singleton_method(:reserve) { |path| reserved << path }
    budget.define_singleton_method(:mark_rate_limited) { |**_notice| rate_limited += 1 }
    provider.attach_weight_budget(budget)
    error = assert_raises(SWAP::FixedFloatApiError) { provider.get_status(BASE_ORDER) }
    assert_equal "rate_limited", error.kind
    assert_equal 429, error.http_status
    assert_equal ["order"], reserved
    assert_equal 1, rate_limited
  end

  # Mirrors "a 429 hands the guard the path and the provider's own wait" in
  # tests/fixedfloat.test.mjs: the wait is the Retry-After header in whole
  # seconds, else a positive `retry_after` number in the response data.
  def notice_for(answer)
    provider, = make_provider("order" => -> { answer })
    notices = []
    budget = Object.new
    budget.define_singleton_method(:reserve) { |_path| nil }
    budget.define_singleton_method(:mark_rate_limited) { |**notice| notices << notice }
    provider.attach_weight_budget(budget)
    error = assert_raises(SWAP::FixedFloatApiError) { provider.get_status(BASE_ORDER) }
    assert_equal "rate_limited", error.kind
    assert_equal 1, notices.length
    notices.first
  end

  def test_a_429_hands_the_guard_the_path_and_the_providers_own_wait
    envelope = ->(data) { JSON.generate("code" => 429, "msg" => "Rate limit", "data" => data) }
    # Lightning Swap answers a refused call with Retry-After and a body.
    assert_equal({ path: "order", retry_after_seconds: 17 },
                 notice_for(status: 429, headers: { "Retry-After" => "17" }, body: envelope.call(nil)))
    assert_equal({ path: "order", retry_after_seconds: 41 },
                 notice_for(status: 429,
                            body: envelope.call("errors" => ["RATE_LIMIT"], "retry_after" => 41)))
    assert_equal({ path: "order" },
                 notice_for(status: 429, body: JSON.generate("code" => 1, "msg" => "Too many requests")))
  end

  def test_the_wait_is_read_from_the_header_first_and_only_when_it_is_whole_seconds
    body = JSON.generate("code" => 429, "msg" => "Rate limit", "data" => { "retry_after" => 41 })
    # The header wins over the body, in any case and as Net::HTTP spells it.
    assert_equal 17, notice_for(status: 429, headers: { "retry-after" => " 17 " }, body: body)[:retry_after_seconds]
    assert_equal 17, notice_for(status: 429, headers: { "RETRY-AFTER" => ["17"] }, body: body)[:retry_after_seconds]
    assert_equal 17, notice_for("status" => 429, "headers" => { "Retry-After" => "17" }, "body" => body)[:retry_after_seconds]
    # A date, a fraction or a sign is not whole seconds: the body is read.
    ["Wed, 21 Oct 2026 07:28:00 GMT", "1.5", "-3", "", "12s"].each do |header|
      assert_equal 41, notice_for(status: 429, headers: { "Retry-After" => header }, body: body)[:retry_after_seconds],
                   header
    end
    # The body names a wait only with a positive number.
    [{ "retry_after" => "41" }, { "retry_after" => 0 }, { "retry_after" => -5 }, { "retry_after" => nil },
     { "retry_after" => true }, {}, nil, [41], "41"].each do |data|
      answer = { status: 429, body: JSON.generate("code" => 429, "msg" => "Rate limit", "data" => data) }
      assert_equal({ path: "order" }, notice_for(answer), data.inspect)
    end
    fraction = JSON.generate("code" => 429, "msg" => "Rate limit", "data" => { "retry_after" => 2.5 })
    assert_equal 2.5, notice_for(status: 429, body: fraction)[:retry_after_seconds]
  end

  # The 429 reaches the real guard: on Lightning Swap a refused create stops
  # creates for the wait it names, and status calls keep going.
  def test_a_429_on_a_create_stands_the_real_guard_off_for_the_named_wait
    now = NOW
    routes = {
      "ccies" => { "ccies" => SAMPLE_CCIES },
      "create" => lambda do
        { status: 429, headers: { "Retry-After" => "12" },
          body: JSON.generate("code" => 429, "msg" => "Rate limit", "data" => nil) }
      end,
      "order" => { "status" => "NEW" }
    }
    provider, calls = make_provider(routes, base_url: "https://lightning-swap.com")
    provider.attach_weight_budget(
      SWAP::SwapProviderWeightBudget.new(provider.name, -> { now }, provider.limits)
    )
    create = lambda do
      provider.create_swap(pay_in_asset: "USDT_TRON", bolt11: BOLT11, invoice_amount_msats: INVOICE_AMOUNT_MSATS)
    end
    assert_equal "rate_limited", assert_raises(SWAP::FixedFloatApiError) { create.call }.kind
    denied = assert_raises(SWAP::WeightBudgetError) { create.call }
    assert_equal ["backoff", NOW + 12], denied.denial.values_at("reason", "backoff_until")
    assert_raises(SWAP::WeightBudgetError) { provider.assert_create_available }
    assert_equal 1, calls.count { |call| call[:path] == "create" }
    assert_equal "awaiting_deposit", provider.get_status(BASE_ORDER).fetch("state")
    now = NOW + 12
    provider.assert_create_available
    assert_equal "rate_limited", assert_raises(SWAP::FixedFloatApiError) { create.call }.kind
  end

  def test_only_fixedfloats_own_host_is_counted_locally
    lightning_swap = make_provider({}, base_url: "https://api.lightning-swap.com/v1/").first
    assert_same SWAP::PROVIDER_ONLY_SWAP_PROVIDER_LIMITS, lightning_swap.limits
    assert_same SWAP::PROVIDER_ONLY_SWAP_PROVIDER_LIMITS, make_provider({}, base_url: "https://evil-ff.io").first.limits
    assert_same SWAP::FIXEDFLOAT_SWAP_PROVIDER_LIMITS, make_provider({}, base_url: "https://api.FF.io/v2/").first.limits
    default_host = SWAP::FixedFloatProvider.new(key: "k", secret: "s", http: ->(**_r) {}, now: -> { NOW })
    assert_equal "fixedfloat", default_host.limits.profile
    # Asking is harmless before a guard is attached, and with one that
    # predates the check.
    assert_nil lightning_swap.assert_create_available
    old_guard = Object.new
    old_guard.define_singleton_method(:reserve) { |_path| nil }
    lightning_swap.attach_weight_budget(old_guard)
    assert_nil lightning_swap.assert_create_available
  end

  def test_provider_logs_requests_and_responses_without_secrets
    provider, = make_provider(
      "ccies" => SAMPLE_CCIES, "rates/fixed.xml" => FAILOVER_RATES_XML
    )
    events = []
    provider.attach_api_request_logger(->(entry) { events << ["request", entry] })
    provider.attach_api_response_logger(->(entry) { events << ["response", entry] })
    catalog = provider.pay_in_asset_catalog
    assert catalog.any? { |item| item["pay_asset"] == "USDT_TRON" }

    request_paths = events.filter_map { |kind, entry| entry["path"] if kind == "request" }
    assert_includes request_paths, "ccies"
    assert_includes request_paths, "rates/fixed.xml"
    rates_response = events.find do |kind, entry|
      kind == "response" && entry["path"] == "rates/fixed.xml" && entry["ok"]
    end
    # DOGE→BTC and ETH→USDT are ignored; only OpenReceive LN pairs remain.
    assert_equal true, rates_response[1].fetch("has_data")
    serialized = JSON.generate(events)
    refute_includes serialized, API_SECRET
    refute_includes serialized, "X-API-KEY"
    refute_includes serialized, "X-API-SIGN"
  end

  def test_order_diagnostic_hooks_only_receive_safe_summaries_and_cannot_break_refunds
    provider, calls = make_provider("ccies" => SAMPLE_CCIES, "create" => CREATE_DATA,
                                   "order" => CREATE_DATA, "emergency" => {})
    events = []
    provider.attach_api_request_logger(->(entry) { events << entry })
    provider.attach_api_response_logger(->(entry) { events << entry })
    order = provider.create_swap(pay_in_asset: "USDT_TRON", bolt11: BOLT11, invoice_amount_msats: INVOICE_AMOUNT_MSATS)
    provider.get_status(order)
    provider.request_refund(order, TRX_ADDRESS)
    serialized = JSON.generate(events)
    [API_KEY, API_SECRET, "TOKEN1", BOLT11, TRX_ADDRESS, "X-API-KEY", "X-API-SIGN"].each do |secret|
      refute_includes serialized, secret
    end
    assert_equal "TOKEN1", order.fetch("provider_token")
    assert_equal "TOKEN1", calls.find { |call| call[:path] == "emergency" }[:body].fetch("token")
    assert events.any? { |event| event["path"] == "order" && event["has_token"] }
    assert events.any? { |event| event["path"] == "create" && event["has_data"] }
    provider.attach_api_request_logger(->(_entry) { raise "sink unavailable" })
    provider.attach_api_response_logger(->(_entry) { raise "sink unavailable" })
    provider.get_status(order)
    provider.request_refund(order, TRX_ADDRESS)
  end

  def test_quote_derives_pay_amount_and_limits_from_the_rates_feed
    provider, = make_provider("ccies" => SAMPLE_CCIES, "rates/fixed.xml" => SAMPLE_XML)
    quote = provider.quote(pay_in_asset: "USDT_TRON", invoice_amount_msats: INVOICE_AMOUNT_MSATS)
    assert_equal true, quote.fetch("available")
    assert_equal "fixedfloat", quote.fetch("provider")
    assert_equal "USDT_TRON", quote.fetch("pay_asset")
    # 20_000 sats at 315/0.005 plus the 1-sat tofee: ceil((20000+1)*63000)/1e8.
    assert_equal "12.60063", quote.fetch("pay_amount")
    assert_equal "10", quote.fetch("minimum_pay_amount")
    assert_equal "11340", quote.fetch("maximum_pay_amount")
    assert_equal 15_874_000, quote.fetch("minimum_invoice_amount_msats")
    assert_equal 18_000_000_000, quote.fetch("maximum_invoice_amount_msats")
  end

  def test_quote_reports_amount_out_of_limits_without_hitting_price
    provider, calls = make_provider("ccies" => SAMPLE_CCIES, "rates/fixed.xml" => SAMPLE_XML)
    below = provider.quote(pay_in_asset: "USDT_TRON", invoice_amount_msats: 1_000_000)
    assert_equal false, below.fetch("available")
    assert_equal "amount_too_small", below.fetch("unavailable_reason")
    assert_equal "This invoice is below the provider minimum.", below.fetch("unavailable_message")

    above = provider.quote(pay_in_asset: "USDT_TRON", invoice_amount_msats: 19_000_000_000)
    assert_equal "amount_too_large", above.fetch("unavailable_reason")
    assert_equal "This invoice is above the provider maximum.", above.fetch("unavailable_message")
    refute_includes calls.map { |call| call[:path] }, "price"
  end

  def test_quote_reports_pair_temporarily_unavailable_when_the_pair_is_missing
    provider, = make_provider(
      "ccies" => SAMPLE_CCIES,
      # SOL has no SOL:BTCLN pair in this dump.
      "rates/fixed.xml" => SAMPLE_XML
    )
    quote = provider.quote(pay_in_asset: "SOL_SOL", invoice_amount_msats: INVOICE_AMOUNT_MSATS)
    assert_equal false, quote.fetch("available")
    assert_equal "pair_temporarily_unavailable", quote.fetch("unavailable_reason")
    assert_equal "This payment route is temporarily unavailable.", quote.fetch("unavailable_message")
  end

  def test_quote_fails_closed_when_the_rates_feed_is_down
    provider, = make_provider(
      "ccies" => SAMPLE_CCIES,
      "rates/fixed.xml" => -> { raise "connect ECONNREFUSED" }
    )
    # Rates/network failures must raise (fail closed) so the service can skip
    # this provider — never be swallowed into an unavailable quote.
    assert_raises(RuntimeError) do
      provider.quote(pay_in_asset: "USDT_TRON", invoice_amount_msats: INVOICE_AMOUNT_MSATS)
    end
  end

  def test_invoice_expiry_floor_and_derivation
    provider, = make_provider({})
    # deposit_window(600) + settlement_sla(900) + margin(300).
    assert_equal 1800, provider.invoice_expiry_seconds(pay_in_asset: "USDT_TRON")
    error = assert_raises(ArgumentError) do
      make_provider({}, invoice_expiry_seconds: 900)
    end
    assert_match(/must be at least 1800/, error.message)
    shorter, = make_provider({}, deposit_window_seconds: 300, settlement_sla_seconds: 300,
                                 invoice_expiry_margin_seconds: 60)
    assert_equal 660, shorter.invoice_expiry_seconds
  end

  def test_provider_id_and_credential_validation
    assert_raises(ArgumentError) { make_provider({}, id: "Bad Provider!") }
    assert_raises(ArgumentError) do
      SWAP::FixedFloatProvider.new(key: " ", secret: "s", http: ->(**_r) {}, now: -> { NOW })
    end
    assert_raises(ArgumentError) do
      SWAP::FixedFloatProvider.new(key: "k", secret: " ", http: ->(**_r) {}, now: -> { NOW })
    end
  end
end

class SwapWeightBudgetTest < Minitest::Test
  def test_budget_meters_create_weight_and_backs_off_on_rate_limits
    now = 1_000
    budget = SWAP::SwapProviderWeightBudget.new("fixedfloat", -> { now }, SWAP::FIXEDFLOAT_SWAP_PROVIDER_LIMITS)
    # create weighs 50 against the 200 soft cap: the fifth create exhausts it.
    4.times { budget.reserve("create") }
    error = assert_raises(SWAP::WeightBudgetError) { budget.reserve("create") }
    assert SWAP.weight_budget_error?(error)
    assert_equal "exhausted", error.denial.fetch("reason")
    # A provider 429 marks the budget rate limited, late in the window.
    now = 1_059
    budget.mark_rate_limited
    assert_raises(SWAP::WeightBudgetError) { budget.reserve("order") }
    # The weight window rolls at second 60, but the 60s backoff does NOT ride
    # along with it: a 429 at second 59 must not be forgiven one second later.
    now = 1_061
    backoff = assert_raises(SWAP::WeightBudgetError) { budget.reserve("create") }
    assert_equal "backoff", backoff.denial.fetch("reason")
    # It expires on its own clock (1_059 + 60).
    now = 1_120
    budget.reserve("create")
  end

  LIMITS_VECTOR = JSON.parse(
    File.read(File.expand_path("../../../../spec/test-vectors/swap-provider-limits.json", __dir__))
  )
  PROFILES = {
    "fixedfloat" => SWAP::FIXEDFLOAT_SWAP_PROVIDER_LIMITS,
    "provider-only" => SWAP::PROVIDER_ONLY_SWAP_PROVIDER_LIMITS
  }.freeze

  # Twin of "swap-provider-limits: only FixedFloat's own host is counted
  # locally" in tests/crosslang.test.mjs.
  def test_swap_provider_limits_vector_profiles_carry_the_shared_numbers
    assert_equal LIMITS_VECTOR.fetch("window_seconds"), SWAP::SwapProviderWeightBudget::WINDOW_SECONDS
    assert_equal LIMITS_VECTOR.fetch("profiles").keys.sort, PROFILES.keys.sort
    LIMITS_VECTOR.fetch("profiles").each do |name, expected|
      limits = PROFILES.fetch(name)
      assert_equal name, limits.profile
      actual = limits.to_h.transform_keys(&:to_s).except("profile")
      actual["local_budget"] = actual.fetch("local_budget")&.to_h&.transform_keys(&:to_s)
      assert_equal expected, actual, name
      assert limits.frozen?, "#{name} limits must not be editable in place"
      assert limits.local_budget.frozen?, "#{name} budget must not be editable in place" unless limits.local_budget.nil?
    end
  end

  def test_swap_provider_limits_vector_hosts_pick_the_profile
    refute_empty LIMITS_VECTOR.fetch("hosts")
    LIMITS_VECTOR.fetch("hosts").each do |item|
      assert_equal item.fetch("profile"), SWAP::SwapProviderLimits.for_base_url(item.fetch("base_url")).profile,
                   item.fetch("base_url")
    end
  end

  def test_swap_provider_limits_vector_scenarios
    refute_empty LIMITS_VECTOR.fetch("scenarios")
    LIMITS_VECTOR.fetch("scenarios").each do |scenario|
      now = scenario.fetch("steps").first.fetch("at")
      budget = SWAP::SwapProviderWeightBudget.new("vector", -> { now }, PROFILES.fetch(scenario.fetch("profile")))
      scenario.fetch("steps").each_with_index do |step, index|
        now = step.fetch("at")
        label = "#{scenario.fetch('name')}: step #{index + 1} " \
                "(#{step.fetch('op')} #{step['path']} at #{step.fetch('at')})"
        step.fetch("repeat", 1).times do
          if step.fetch("op") == "rate_limited"
            budget.mark_rate_limited(
              **{ path: step["path"], retry_after_seconds: step["retry_after"] }.compact
            )
            next
          end
          outcome =
            begin
              step.fetch("op") == "check" ? budget.assert_available(step.fetch("path")) : budget.reserve(step.fetch("path"))
              { "result" => "ok" }
            rescue SWAP::WeightBudgetError => e
              { "result" => e.denial.fetch("reason"), "until" => e.denial["backoff_until"] }
            end
          assert_equal step.fetch("expect"), outcome.fetch("result"), label
          assert_equal step.fetch("backoff_until"), outcome["until"], label if step.key?("backoff_until")
        end
      end
    end
  end

  def test_a_fixedfloat_denial_says_which_limit_was_reached
    budget = SWAP::SwapProviderWeightBudget.new("fixedfloat", -> { 1_000 }, SWAP::FIXEDFLOAT_SWAP_PROVIDER_LIMITS)
    # Fifty status polls spend the share the calls that are not creates have...
    50.times { budget.reserve("order") }
    denied = assert_raises(SWAP::WeightBudgetError) { budget.reserve("order") }
    assert_match(/calls other than creates exhausted \(50\+1 > 50\)/, denied.message)
    assert_equal ["exhausted", 50, 50], denied.denial.values_at("reason", "used", "gate")
    refute denied.denial.key?("backoff_until")
    # ...and three payers can still start a swap this minute.
    3.times { budget.reserve("create") }
    denied = assert_raises(SWAP::WeightBudgetError) { budget.assert_available("create") }
    assert_match(/weight budget exhausted \(200\+50 > 200\)/, denied.message)
    assert_equal ["exhausted", 200, 200], denied.denial.values_at("reason", "used", "gate")
  end

  def test_the_guard_counts_nothing_for_any_other_provider
    [nil, SWAP::PROVIDER_ONLY_SWAP_PROVIDER_LIMITS].each do |limits|
      budget = SWAP::SwapProviderWeightBudget.new("ls", -> { 1_000 }, *[limits].compact)
      500.times { budget.reserve("create") }
      2_000.times { budget.reserve("order") }
      assert_nil budget.assert_available("create")
      # A guard that counts nothing reports no counts when it stands off.
      budget.mark_rate_limited(path: "create", retry_after_seconds: 12)
      denied = assert_raises(SWAP::WeightBudgetError) { budget.reserve("create") }
      assert_equal({ "reason" => "backoff", "backoff_until" => 1_012 }, denied.denial.slice("reason", "backoff_until", "used", "gate"))
      budget.reserve("order")
    end
  end

  def test_a_wait_that_is_not_a_positive_number_means_the_profiles_own_backoff
    [nil, 0, -5, Float::NAN, Float::INFINITY, "12", true].each do |wait|
      budget = SWAP::SwapProviderWeightBudget.new("ls", -> { 1_000 }, SWAP::PROVIDER_ONLY_SWAP_PROVIDER_LIMITS)
      budget.mark_rate_limited(path: "create", retry_after_seconds: wait)
      denied = assert_raises(SWAP::WeightBudgetError) { budget.assert_available("create") }
      assert_equal 1_060, denied.denial.fetch("backoff_until"), wait.inspect
    end
    # A fraction is rounded up; a number past any clock is the longest wait.
    { 0.2 => 1_001, 12.01 => 1_013, 10**400 => 1_300 }.each do |wait, standoff_end|
      budget = SWAP::SwapProviderWeightBudget.new("ls", -> { 1_000 }, SWAP::PROVIDER_ONLY_SWAP_PROVIDER_LIMITS)
      budget.mark_rate_limited(path: "create", retry_after_seconds: wait)
      denied = assert_raises(SWAP::WeightBudgetError) { budget.assert_available("create") }
      assert_equal standoff_end, denied.denial.fetch("backoff_until"), wait.inspect
    end
  end

  def test_a_429_with_no_path_stops_every_call_and_restarts_the_window
    now = 1_000
    budget = SWAP::SwapProviderWeightBudget.new("fixedfloat", -> { now }, SWAP::FIXEDFLOAT_SWAP_PROVIDER_LIMITS)
    4.times { budget.reserve("create") }
    budget.mark_rate_limited(retry_after_seconds: 90)
    assert_raises(SWAP::WeightBudgetError) { budget.reserve("order") }
    # The provider's window is fresh once the stand-off ends: the creates
    # counted before it are not held against the next minute.
    now = 1_090
    4.times { budget.reserve("create") }
    assert_raises(SWAP::WeightBudgetError) { budget.reserve("create") }
    now = 1_149
    assert_raises(SWAP::WeightBudgetError) { budget.reserve("create") }
    now = 1_150
    budget.reserve("create")
  end
end

class SwapServiceIntegrationTest < Minitest::Test
  class Wallet
    attr_reader :transactions, :last_request

    def initialize(now: NOW)
      @counter = 0
      @transactions = []
      @now = now
    end

    def make_invoice(request)
      @counter += 1
      @last_request = request
      hash = @counter.to_s(16).rjust(64, "0")
      { "invoice" => "ln-test-#{@counter}", "payment_hash" => hash,
        "amount_msats" => request.fetch("amount_msats"), "created_at" => @now,
        "expires_at" => @now + request.fetch("expiry") }
    end

    def list_transactions(_request)
      { "transactions" => @transactions }
    end
  end

  def build_lsc_env
    {
      "LSC_URI_PRIMARY" => "lightning+swapconnect://primary.example/?key=primary-key&secret=primary-secret",
      "LSC_URI_BACKUP" => "lightning+swapconnect://backup.example/?key=backup-key&secret=backup-secret"
    }
  end

  # One transport shared by all LSC-built providers; behavior per host:
  # :ok (serve ccies + rates), :down (network error), or a ccies override.
  def host_transport(host_behavior, calls)
    lambda do |method:, url:, headers:, body: nil, timeout_ms: nil|
      uri = URI.parse(url)
      calls << { host: uri.host, url: url, method: method }
      behavior = host_behavior[uri.host] || { mode: :ok }
      raise "connect ECONNREFUSED #{uri.host}" if behavior[:mode] == :down
      if uri.path.end_with?("/rates/fixed.xml")
        { status: 200, body: behavior[:rates_xml] || FAILOVER_RATES_XML }
      elsif uri.path.include?("/api/v2/ccies")
        { status: 200,
          body: JSON.generate("code" => 0, "msg" => "OK", "data" => behavior[:ccies] || SAMPLE_CCIES) }
      else
        { status: 500, body: JSON.generate("code" => 1, "msg" => "unexpected #{url}") }
      end
    end
  end

  def build_service(host_behavior)
    calls = []
    wallet = Wallet.new
    providers = SWAP.providers_from_environment(
      build_lsc_env, http: host_transport(host_behavior, calls), now: -> { NOW }
    )
    service = OpenReceive::Server::Service.new(
      nwc_client: wallet,
      price_provider: OpenReceive::Rates::StaticPriceProvider.new,
      swap_providers: providers,
      clock: -> { NOW }
    )
    [service, calls, wallet]
  end

  def test_providers_from_environment_builds_primary_then_backup
    providers = SWAP.providers_from_environment(build_lsc_env, http: ->(**_r) {}, now: -> { NOW })
    assert_equal %w[primary-example backup-example], providers.map(&:name)
    # Config#lsc_connections wires to the same providers.
    config = OpenReceive::Server::Config.load(env: build_lsc_env)
    assert_equal %w[primary-example backup-example],
                 config.swap_providers(http: ->(**_r) {}, now: -> { NOW }).map(&:name)
    assert_empty SWAP.providers_from_environment({})
    error = assert_raises(ArgumentError) do
      SWAP.providers_from_environment({ "LSC_URI_PRIMARY" => "https://not-lsc.example" })
    end
    assert_match(/LSC_URI_PRIMARY is invalid/, error.message)
  end

  def test_list_swap_options_uses_only_primary_while_primary_is_healthy
    service, calls, = build_service(
      "primary.example" => { mode: :ok }, "backup.example" => { mode: :ok }
    )
    options = service.list_swap_options(amount_msats: INVOICE_AMOUNT_MSATS)
    assert_equal SWAP::Assets::PAY_IN_ASSETS, options.map { |option| option.fetch("pay_in_asset") }
    usdt = options.find { |option| option.fetch("pay_in_asset") == "USDT_TRON" }
    assert_equal(
      {
        "pay_in_asset" => "USDT_TRON",
        "label" => "USDT",
        "network_label" => "Tron",
        "provider" => "primary-example",
        "available" => true,
        "minimum_pay_amount" => "10",
        "maximum_pay_amount" => "11340",
        "minimum_invoice_amount_msats" => 15_874_000,
        "maximum_invoice_amount_msats" => 18_000_000_000
      },
      usdt
    )
    eth = options.find { |option| option.fetch("pay_in_asset") == "ETH_ETH" }
    assert_equal false, eth.fetch("available")
    assert_equal "provider_unconfigured", eth.fetch("unavailable_reason")
    assert_equal "", eth.fetch("provider")
    refute calls.any? { |call| call[:host] == "backup.example" },
           "backup must not be contacted while primary is healthy"
  end

  def test_list_swap_options_is_amount_aware
    service, = build_service("primary.example" => { mode: :ok })
    below = service.list_swap_options(amount_msats: 2_000_000)
                   .find { |option| option.fetch("pay_in_asset") == "USDT_TRON" }
    assert_equal false, below.fetch("available")
    assert_equal "amount_too_small", below.fetch("unavailable_reason")
    assert_equal "This invoice is below the provider minimum.", below.fetch("unavailable_message")
    # Limits stay on the wire so the widget can show the accepted range.
    assert_equal 15_874_000, below.fetch("minimum_invoice_amount_msats")

    above = service.list_swap_options(amount_msats: 19_000_000_000)
                   .find { |option| option.fetch("pay_in_asset") == "USDT_TRON" }
    assert_equal "amount_too_large", above.fetch("unavailable_reason")
    assert_equal "This invoice is above the provider maximum.", above.fetch("unavailable_message")

    error = assert_raises(OpenReceive::Server::ValidationError) do
      service.list_swap_options(amount_msats: 999)
    end
    assert_equal "amountMsats must be an integer >= 1000.", error.message
  end

  def test_list_swap_options_fails_over_to_backup_only_when_primary_is_down
    service, calls, = build_service(
      "primary.example" => { mode: :down }, "backup.example" => { mode: :ok }
    )
    usdt = service.list_swap_options(amount_msats: INVOICE_AMOUNT_MSATS)
                  .find { |option| option.fetch("pay_in_asset") == "USDT_TRON" }
    assert_equal "backup-example", usdt.fetch("provider")
    assert calls.any? { |call| call[:host] == "primary.example" }
    assert calls.any? { |call| call[:host] == "backup.example" }
  end

  def test_healthy_primary_that_omits_an_asset_does_not_fall_through_to_backup
    service, calls, = build_service(
      "primary.example" => {
        mode: :ok,
        # Primary is up but only lists SOL — no USDT_TRON mapping.
        ccies: [
          { "code" => "SOL", "coin" => "SOL", "network" => "SOL", "recv" => true, "send" => true },
          { "code" => "BTCLN", "coin" => "BTC", "network" => "LIGHTNING", "recv" => false, "send" => true }
        ]
      },
      "backup.example" => { mode: :ok }
    )
    usdt = service.list_swap_options(amount_msats: INVOICE_AMOUNT_MSATS)
                  .find { |option| option.fetch("pay_in_asset") == "USDT_TRON" }
    assert_equal false, usdt.fetch("available")
    assert_equal "", usdt.fetch("provider")
    refute calls.any? { |call| call[:host] == "backup.example" },
           "backup must stay idle when primary answered"
  end

  # Providers ARE configured here, they are just down — so the payer is told
  # "temporarily unreachable", not "not configured". The label is cached per
  # amount for up to 60s, so the wrong one outlasts the outage that caused it.
  def test_all_providers_down_soft_fails_to_unreachable_options
    service, = build_service(
      "primary.example" => { mode: :down }, "backup.example" => { mode: :down }
    )
    options = service.list_swap_options(amount_msats: INVOICE_AMOUNT_MSATS)
    assert_equal SWAP::Assets::PAY_IN_ASSETS.length, options.length
    assert(options.all? { |option| option.fetch("provider") == "" })
    assert(options.all? { |option| option.fetch("unavailable_reason") == "provider_unreachable" })
    assert(
      options.all? do |option|
        option.fetch("unavailable_message") == "The swap provider is temporarily unreachable."
      end
    )
  end


  def test_quote_swap_produces_the_wire_shape
    service, = build_service("primary.example" => { mode: :ok })
    quote = service.quote_swap("amount" => { "sats" => 20_000 }, "pay_in_asset" => "USDT_TRON")
    assert_equal(
      {
        "provider" => "primary-example",
        "pay_asset" => "USDT_TRON",
        "available" => true,
        "pay_amount" => "12.6",
        "minimum_pay_amount" => "10",
        "maximum_pay_amount" => "11340",
        "minimum_invoice_amount_msats" => 15_874_000,
        "maximum_invoice_amount_msats" => 18_000_000_000
      },
      quote
    )
  end

  def test_quote_swap_rejects_unknown_assets_with_the_js_message
    service, = build_service("primary.example" => { mode: :ok })
    error = assert_raises(OpenReceive::Server::ValidationError) do
      service.quote_swap("amount" => { "sats" => 20_000 }, "pay_in_asset" => "DOGE_DOGE")
    end
    assert_equal "payInAsset is not supported.", error.message
  end

  def test_no_providers_maps_to_503_internal
    service = OpenReceive::Server::Service.new(
      nwc_client: Wallet.new, swap_providers: [], clock: -> { NOW }
    )
    error = assert_raises(OpenReceive::Server::ServiceError) do
      service.quote_swap("amount" => { "sats" => 20_000 }, "pay_in_asset" => "USDT_TRON")
    end
    assert_equal 503, error.status
    assert_equal "INTERNAL", error.code
    assert_equal "No configured swap provider supports USDT_TRON.", error.message
    assert_equal [], service.list_swap_options(amount_msats: INVOICE_AMOUNT_MSATS)
  end

  def test_create_swap_flows_end_to_end_with_the_fixedfloat_provider
    calls = []
    transport = host_transport(
      { "primary.example" => { mode: :ok, rates_xml: SAMPLE_XML } }, calls
    )
    routed = lambda do |method:, url:, headers:, body: nil, timeout_ms: nil|
      if url.include?("/api/v2/create")
        calls << { host: "primary.example", url: url, method: method, raw_body: body }
        { status: 200, body: JSON.generate("code" => 0, "msg" => "OK", "data" => CREATE_DATA) }
      elsif url.include?("/api/v2/order")
        { status: 200,
          body: JSON.generate("code" => 0, "msg" => "OK",
                              "data" => { "status" => "EMERGENCY", "emergency" => { "status" => ["LESS"] } }) }
      elsif url.include?("/api/v2/emergency")
        calls << { host: "primary.example", url: url, method: method, emergency: JSON.parse(body) }
        { status: 200, body: JSON.generate("code" => 0, "msg" => "OK", "data" => {}) }
      else
        transport.call(method: method, url: url, headers: headers, body: body, timeout_ms: timeout_ms)
      end
    end
    provider = SWAP::FixedFloatProvider.new(
      id: "primary-example", key: "primary-key", secret: "primary-secret",
      base_url: "https://primary.example", http: routed, now: -> { NOW }
    )
    wallet = Wallet.new
    service = OpenReceive::Server::Service.new(
      nwc_client: wallet, swap_providers: [provider], clock: -> { NOW }
    )

    swap = service.create_swap(
      "reference" => "ruby-ff-1", "amount" => { "sats" => 20_000 }, "pay_in_asset" => "USDT_TRON"
    )
    # The provider-mandated shadow-invoice expiry (1800s) reaches the wallet.
    assert_equal 1800, wallet.last_request.fetch("expiry")
    assert_equal "primary-example", swap.fetch("provider")
    assert_equal TRX_ADDRESS, swap.fetch("deposit_address")
    assert_equal "12.5", swap.fetch("deposit_amount")
    assert_equal "awaiting_deposit", swap.fetch("provider_state")
    assert_equal NOW + 550, swap.fetch("provider_expires_at")
    checkout = swap.fetch("checkout")
    assert_equal NOW + 1800, checkout.fetch("expires_at")
    swap_data = swap.fetch("swap_data")
    assert_equal 1, swap_data.fetch("version")
    refute swap_data.fetch("provider_order").key?("raw")
    assert_equal "TOKEN1", swap_data.dig("provider_order", "provider_token")

    # Status recovery from host-persisted swap_data: EMERGENCY LESS maps to
    # refund_required/underpaid; then a refund round-trips through /emergency.
    stored = JSON.parse(JSON.generate(swap_data))
    status = service.get_swap(
      reference: "ruby-ff-1", payment_hash: swap.fetch("payment_hash"), swap_data: stored
    )
    assert_equal "refund_required", status.fetch("provider_state")
    assert_equal "underpaid", status.fetch("refund_reason")

    refunded = service.refund_swap(
      reference: "ruby-ff-1", payment_hash: swap.fetch("payment_hash"),
      swap_data: stored, refund_address: TRX_ADDRESS
    )
    emergency_call = calls.find { |call| call[:emergency] }
    assert_equal(
      { "id" => "ORDER1", "token" => "TOKEN1", "choice" => "REFUND", "address" => TRX_ADDRESS },
      emergency_call[:emergency]
    )
    assert_equal "refund_required", refunded.fetch("provider_state")
  end

  def test_refund_from_a_non_refund_state_is_a_409_conflict
    provider, = make_provider("order" => { "status" => "PENDING" })
    service = OpenReceive::Server::Service.new(
      nwc_client: Wallet.new, swap_providers: [provider], clock: -> { NOW }
    )
    swap_data = { "version" => 1, "provider_order" => BASE_ORDER.dup }
    error = assert_raises(OpenReceive::Server::ConflictError) do
      service.refund_swap(
        reference: "ruby-ff-2", payment_hash: "7f" * 32,
        swap_data: swap_data, refund_address: TRX_ADDRESS
      )
    end
    assert_equal 409, error.status
    assert_equal "Swap cannot be refunded from provider state confirming.", error.message
  end

  def test_invalid_swap_data_and_unconfigured_provider_map_like_js
    service = OpenReceive::Server::Service.new(
      nwc_client: Wallet.new, swap_providers: [], clock: -> { NOW }
    )
    error = assert_raises(OpenReceive::Server::ValidationError) do
      service.get_swap(reference: "x", payment_hash: "7f" * 32, swap_data: { "version" => 2 })
    end
    assert_equal "swapData is invalid.", error.message

    error = assert_raises(OpenReceive::Server::ServiceError) do
      service.get_swap(
        reference: "x", payment_hash: "7f" * 32,
        swap_data: { "version" => 1, "provider_order" => BASE_ORDER.dup }
      )
    end
    assert_equal 503, error.status
    assert_equal "Swap provider fixedfloat is not configured.", error.message
  end

  def test_service_auto_builds_lsc_providers_and_default_price_feed
    service = OpenReceive::Server::Service.new(
      nwc_client: Wallet.new, clock: -> { NOW },
      env: build_lsc_env.merge(
        "OPENRECEIVE_PRICE_FEED_PRIMARY_URL" => "https://price-override.example/simple/price"
      )
    )
    providers = service.instance_variable_get(:@swap_providers)
    assert_equal %w[primary-example backup-example], providers.map(&:name)
    feed = service.instance_variable_get(:@price_provider)
    assert_kind_of OpenReceive::Rates::CachedPriceFeed, feed
    assert_equal "https://price-override.example/simple/price",
                 feed.instance_variable_get(:@primary).url
    # An explicitly empty provider list stays empty (mirrors swap.providers []).
    disabled = OpenReceive::Server::Service.new(
      nwc_client: Wallet.new, swap_providers: [], clock: -> { NOW }, env: build_lsc_env
    )
    assert_empty disabled.instance_variable_get(:@swap_providers)
  end

  def test_price_feed_failures_map_to_retryable_503
    failing = Object.new
    failing.define_singleton_method(:btc_fiat_price) do |_currency|
      raise OpenReceive::PriceFeedError, "all price feeds failed"
    end
    service = OpenReceive::Server::Service.new(
      nwc_client: Wallet.new, price_provider: failing, swap_providers: [], clock: -> { NOW }
    )
    error = assert_raises(OpenReceive::Server::ServiceError) do
      service.prepare_checkout("amount" => { "currency" => "USD", "value" => "10.00" })
    end
    assert_equal 503, error.status
    assert_equal "INTERNAL", error.code
    assert_equal true, error.retryable
    assert_equal "Exchange rates are temporarily unavailable — please try again in a moment.",
                 error.message
  end

  def test_check_payment_wire_body_carries_amount_aware_payment_methods
    service, = build_service("primary.example" => { mode: :ok })
    checkout = {
      "reference" => "order-methods", "payment_hash" => "7f" * 32, "bolt11" => "lnbc1",
      "amount_msats" => 2_000_000, "created_at" => NOW, "expires_at" => NOW + 600,
      "fiat_quote" => nil
    }
    handler = OpenReceive::Server::RequestHandler.new(
      service: service,
      authorize: ->(_context) { true },
      resolve_checkout: lambda do |**_context|
        { "amount" => { "sats" => 2_000 }, "payment_hash" => "7f" * 32, "checkout" => checkout }
      end,
      on_checkout_created: ->(**_payment) {},
      on_paid: ->(_payment) {}
    )
    status, _headers, body = handler.check_payment(
      raw_body: JSON.generate("reference" => "order-methods", "payment_hash" => "7f" * 32),
      request: { "CONTENT_TYPE" => "application/json" }, request_id: "req-methods"
    )
    assert_equal 200, status
    usdt = body.fetch("payment_methods").find { |option| option["pay_in_asset"] == "USDT_TRON" }
    # 2_000_000 msats is below the 15_874_000 msats pair minimum.
    assert_equal "amount_too_small", usdt.fetch("unavailable_reason")
  end

  # The mint echoes the same catalog prepare and payments/check do. Without it,
  # a client that minted Lightning lost the pay-in options it renders its picker
  # from until the next poll — and only clients with a library-side merge
  # (@openreceive/browser's `previous`) escaped that. The wire is the contract
  # for a native app or an SDK in another language, so the catalog is on it.
  def test_create_checkout_wire_body_carries_amount_aware_payment_methods
    service, = build_service("primary.example" => { mode: :ok })
    handler = OpenReceive::Server::RequestHandler.new(
      service: service,
      authorize: ->(_context) { true },
      resolve_checkout: ->(**_context) { { "amount" => { "sats" => 2_000 } } },
      on_checkout_created: ->(**_payment) {},
      on_paid: ->(_payment) {}
    )
    status, _headers, body = handler.create_checkout(
      raw_body: JSON.generate("reference" => "order-mint-methods"),
      request: { "CONTENT_TYPE" => "application/json" }, request_id: "req-mint-methods"
    )
    assert_equal 201, status
    assert body.key?("checkout"), "the minted checkout is still the primary payload"
    usdt = body.fetch("payment_methods").find { |option| option["pay_in_asset"] == "USDT_TRON" }
    # Amount-aware against the minted attempt's own amount, exactly as on check:
    # 2_000_000 msats is below the 15_874_000 msats pair minimum.
    assert_equal "amount_too_small", usdt.fetch("unavailable_reason")
  end
end

# A swap provider call that fails reaches the payer as the 502/503 the swap
# routes declare (the JS throughProvider in service/swaps.ts), never the opaque
# 500 "Internal server error.": a refused /create, a provider 429 or outage,
# and this process's own weight budget, which a payer pressing Try again a few
# times spends. Mirrors the Python and PHP swap provider failure tests.
class SwapProviderFailureTest < Minitest::Test
  class Log
    attr_reader :lines

    def initialize
      @lines = []
    end

    def warn(message)
      @lines << message
    end
  end

  REFUSED = -> { { status: 200, body: JSON.generate("code" => 1, "msg" => "Order could not be created") } }

  def setup
    @log = Log.new
    @routes = { "ccies" => { "ccies" => SAMPLE_CCIES }, "create" => CREATE_DATA, "order" => { "status" => "NEW" } }
    @provider, @calls = make_provider(@routes)
    @service = OpenReceive::Server::Service.new(
      nwc_client: SwapServiceIntegrationTest::Wallet.new, swap_providers: [@provider],
      price_provider: false, clock: -> { NOW }, logger: @log
    )
  end

  def create_swap
    @service.create_swap(
      "reference" => "ruby-swap-failure", "amount" => { "sats" => 20_000 }, "pay_in_asset" => "USDT_TRON"
    )
  end

  def test_a_refused_create_is_a_502_with_the_payer_sentence
    @routes["create"] = REFUSED
    error = assert_raises(OpenReceive::Server::ServiceError) { create_swap }
    assert_equal [502, "INTERNAL", "The swap provider refused this request.", nil],
                 [error.status, error.code, error.message, error.retryable]
    # The operator still reads the provider's own words; the payer never does.
    assert(@log.lines.any? { |line| line.include?("Order could not be created") })
  end

  def test_the_weight_budget_after_a_few_try_agains_is_a_retryable_503
    @routes["create"] = REFUSED
    # On FixedFloat's own host, the one the guard counts for, /ccies spent 1
    # and each Try again spends a create weight (50) before the provider
    # answers, so the fourth press would pass the 200 soft cap.
    @provider, @calls = make_provider(@routes, base_url: "https://ff.io")
    @service = OpenReceive::Server::Service.new(
      nwc_client: SwapServiceIntegrationTest::Wallet.new, swap_providers: [@provider],
      price_provider: false, clock: -> { NOW }, logger: @log
    )
    3.times { assert_equal 502, assert_raises(OpenReceive::Server::ServiceError) { create_swap }.status }
    creates = @calls.count { |call| call[:path] == "create" }
    error = assert_raises(OpenReceive::Server::ServiceError) { create_swap }
    assert_equal [503, "INTERNAL", "The swap provider is rate limited. Please try again shortly.", true],
                 [error.status, error.code, error.message, error.retryable]
    assert_equal creates, @calls.count { |call| call[:path] == "create" }
  end

  def test_a_provider_outage_or_429_is_a_retryable_503
    {
      -> { { status: 429, body: JSON.generate("code" => 429, "msg" => "Too many requests") } } =>
        "The swap provider is rate limited. Please try again shortly.",
      -> { { status: 502, body: "bad gateway" } } =>
        "The swap provider is temporarily unreachable. Please try again shortly.",
      -> { raise Errno::ECONNREFUSED } =>
        "The swap provider is temporarily unreachable. Please try again shortly.",
      -> { raise Net::ReadTimeout } =>
        "The swap provider is temporarily unreachable. Please try again shortly."
    }.each do |answer, message|
      setup
      @routes["create"] = answer
      error = assert_raises(OpenReceive::Server::ServiceError) { create_swap }
      assert_equal [503, "INTERNAL", message, true],
                   [error.status, error.code, error.message, error.retryable]
    end
  end

  def test_status_and_refund_calls_map_the_same_way
    swap_data = { "version" => 1, "provider_order" => BASE_ORDER.dup }
    @routes["order"] = REFUSED
    error = assert_raises(OpenReceive::Server::ServiceError) do
      @service.get_swap(reference: "x", payment_hash: "7f" * 32, swap_data: swap_data)
    end
    assert_equal [502, "The swap provider refused this request."], [error.status, error.message]
    @routes["order"] = -> { { status: 503, body: "" } }
    error = assert_raises(OpenReceive::Server::ServiceError) do
      @service.refund_swap(reference: "x", payment_hash: "7f" * 32, swap_data: swap_data, refund_address: TRX_ADDRESS)
    end
    assert_equal [503, true], [error.status, error.retryable]
  end

  def test_classify_transport_failure_matches_the_js_classes
    api = ->(kind, status = nil) { SWAP::FixedFloatApiError.new(path: "create", kind: kind, message: "x", http_status: status) }
    assert_equal "rate_limited", SWAP.classify_transport_failure(SWAP::WeightBudgetError.new("budget", {}))
    assert_equal "rate_limited", SWAP.classify_transport_failure(api.call("rate_limited", 429))
    %w[timeout network invalid_json].each { |kind| assert_equal "unreachable", SWAP.classify_transport_failure(api.call(kind)) }
    assert_equal "unreachable", SWAP.classify_transport_failure(api.call("http", 500))
    assert_equal "refused", SWAP.classify_transport_failure(api.call("http", 400))
    assert_equal "refused", SWAP.classify_transport_failure(api.call("api"))
    assert_nil SWAP.classify_transport_failure(RuntimeError.new("bug"))
  end
end

# The service builds each provider's guard from the provider's own limits,
# asks the guard before the invoice is made, and says in the log why a swap
# call was refused for rate. Mirrors "a create the guard would refuse is refused before
# an invoice is made" in tests/fixedfloat.test.mjs.
class SwapProviderGuardServiceTest < Minitest::Test
  RATE_LIMITED = [503, "INTERNAL", "The swap provider is rate limited. Please try again shortly.", true].freeze

  class CountingWallet < SwapServiceIntegrationTest::Wallet
    attr_reader :invoices

    def initialize(now: NOW)
      super
      @invoices = 0
    end

    def make_invoice(request)
      @invoices += 1
      super
    end
  end

  # A provider the way a host writes one: no HTTP, the guard handed in by the
  # service. `create_swap` and `get_status` reserve, as the real transport does.
  # It states FixedFloat's limits, the only ones the guard counts for.
  class GuardedProvider
    attr_reader :budget, :creates

    def initialize
      @creates = 0
    end

    def name = "fixedfloat"
    def limits = SWAP::FIXEDFLOAT_SWAP_PROVIDER_LIMITS
    def supported_pay_in_assets = ["USDT_TRON"]
    def invoice_expiry_seconds(pay_in_asset: nil) = 1800

    def attach_weight_budget(budget)
      @budget = budget
    end

    def create_swap(pay_in_asset:, bolt11:, invoice_amount_msats:)
      @budget.reserve("create")
      @creates += 1
      BASE_ORDER.merge("pay_in_asset" => pay_in_asset)
    end

    def get_status(order)
      @budget.reserve("order")
      order
    end
  end

  class AskingProvider < GuardedProvider
    def assert_create_available
      @budget.assert_available("create")
    end
  end

  def setup
    @now = NOW
    @wallet = CountingWallet.new
    @log = SwapProviderFailureTest::Log.new
  end

  def service_for(provider)
    OpenReceive::Server::Service.new(
      nwc_client: @wallet, swap_providers: [provider], price_provider: false,
      clock: -> { @now }, logger: @log
    )
  end

  def create_swap(service, reference = "order-busy")
    service.create_swap(
      "reference" => reference, "amount" => { "sats" => 20_000 }, "pay_in_asset" => "USDT_TRON"
    )
  end

  def refused(service, reference = "order-busy")
    error = assert_raises(OpenReceive::Server::ServiceError) { create_swap(service, reference) }
    assert_equal RATE_LIMITED, [error.status, error.code, error.message, error.retryable]
  end

  def rate_limit_lines
    @log.lines.grep(/\Aswap\.provider\.rate_limited: /)
  end

  def test_a_create_the_guard_would_refuse_is_refused_before_an_invoice_is_made
    provider = AskingProvider.new
    service = service_for(provider)
    4.times { provider.budget.reserve("create") }
    2.times { refused(service) }
    assert_equal 0, @wallet.invoices
    assert_equal 0, provider.creates
    # Two refusals, one log line: status polls must not bury the log.
    assert_equal 1, rate_limit_lines.length
    assert_equal "swap.provider.rate_limited: Swap provider call refused locally: this process " \
                 "reached the per-minute limit it keeps for FixedFloat. (provider=fixedfloat " \
                 "path=create reason=exhausted used=200 gate=200)",
                 rate_limit_lines.first
  end

  def test_another_providers_create_stand_off_is_refused_before_an_invoice_is_made
    provider = Class.new(AskingProvider) { undef_method :limits }.new
    service = service_for(provider)
    # A provider that names no limits is never counted locally...
    500.times { provider.budget.reserve("create") }
    2_000.times { provider.budget.reserve("order") }
    # ...but its 429 on a create stops new swaps, before an invoice is made.
    provider.budget.mark_rate_limited(path: "create", retry_after_seconds: 20)
    refused(service)
    assert_equal [0, 0], [@wallet.invoices, provider.creates]
    assert_equal ["swap.provider.rate_limited: Swap provider call refused locally: standing off after " \
                  "the provider's 429. (provider=fixedfloat path=create reason=backoff " \
                  "backoff_until=#{NOW + 20})"],
                 rate_limit_lines
    # Status and refund calls for swaps that already exist keep going.
    provider.budget.reserve("order")
    provider.budget.reserve("emergency")
  end

  def test_asking_uses_no_budget_and_the_create_itself_still_reserves
    provider = AskingProvider.new
    service = service_for(provider)
    4.times { |index| assert_equal "fixedfloat", create_swap(service, "order-#{index}").fetch("provider") }
    assert_equal [4, 4], [@wallet.invoices, provider.creates]
    refused(service, "order-4")
    assert_equal [4, 4], [@wallet.invoices, provider.creates]
  end

  def test_a_provider_without_the_check_is_not_asked
    provider = GuardedProvider.new
    service = service_for(provider)
    4.times { provider.budget.reserve("create") }
    # Not asked, so the request went on to its create. That still meets the
    # guard, and the payer reads the same answer.
    refused(service)
    assert_equal [1, 0], [@wallet.invoices, provider.creates]
  end

  def test_the_real_provider_is_asked_before_the_invoice_is_made
    routes = { "ccies" => { "ccies" => SAMPLE_CCIES }, "create" => SwapProviderFailureTest::REFUSED }
    provider, calls = make_provider(routes, base_url: "https://ff.io")
    service = service_for(provider)
    # /ccies spent 1 and each refused create 50: the fourth would pass the
    # 200 soft cap.
    3.times { assert_equal 502, assert_raises(OpenReceive::Server::ServiceError) { create_swap(service) }.status }
    assert_equal 3, @wallet.invoices
    refused(service)
    assert_equal 3, @wallet.invoices
    assert_equal 3, calls.count { |call| call[:path] == "create" }
  end

  def test_the_guard_follows_the_providers_own_limits
    fixedfloat = AskingProvider.new
    service_for(fixedfloat)
    assert_same SWAP::FIXEDFLOAT_SWAP_PROVIDER_LIMITS, fixedfloat.budget.limits
    4.times { fixedfloat.budget.reserve("create") }
    denied = assert_raises(SWAP::WeightBudgetError) { fixedfloat.budget.reserve("create") }
    assert_equal 200, denied.denial.fetch("gate")

    # A provider that names no limits, or whose `limits` is something else
    # altogether, is never counted locally.
    no_limits = Class.new(AskingProvider) { undef_method :limits }.new
    amount_limits = AskingProvider.new
    amount_limits.define_singleton_method(:limits) { { "minimum_pay_amount" => "10" } }
    [no_limits, amount_limits].each do |provider|
      service_for(provider)
      assert_same SWAP::PROVIDER_ONLY_SWAP_PROVIDER_LIMITS, provider.budget.limits
      500.times { provider.budget.reserve("create") }
      assert_nil provider.budget.assert_available("create")
    end
  end

  def test_a_site_on_any_other_provider_is_never_refused_locally
    routes = { "ccies" => { "ccies" => SAMPLE_CCIES }, "create" => CREATE_DATA, "order" => { "status" => "NEW" } }
    [BASE_URL, "https://lightning-swap.com"].each do |base_url|
      provider, calls = make_provider(routes, base_url: base_url)
      service = service_for(provider)
      40.times { |index| create_swap(service, "order-#{index}") }
      swap_data = { "version" => 1, "provider_order" => BASE_ORDER.dup }
      100.times { service.get_swap(reference: "x", payment_hash: "7f" * 32, swap_data: swap_data) }
      assert_equal 40, calls.count { |call| call[:path] == "create" }, base_url
      assert_equal 100, calls.count { |call| call[:path] == "order" }, base_url
    end
    assert_empty rate_limit_lines
  end

  def test_a_refusal_is_logged_once_a_minute_per_cause
    provider = AskingProvider.new
    service = service_for(provider)
    provider.budget.mark_rate_limited(path: "order", retry_after_seconds: 600)
    swap_data = { "version" => 1, "provider_order" => BASE_ORDER.dup }
    poll = lambda do
      error = assert_raises(OpenReceive::Server::ServiceError) do
        service.get_swap(reference: "x", payment_hash: "7f" * 32, swap_data: swap_data)
      end
      assert_equal RATE_LIMITED, [error.status, error.code, error.message, error.retryable]
    end

    3.times { refused(service) }
    assert_equal ["swap.provider.rate_limited: Swap provider call refused locally: standing off after " \
                  "the provider's 429. (provider=fixedfloat path=create reason=backoff used=0 gate=200 " \
                  "backoff_until=#{NOW + 600})"],
                 rate_limit_lines
    # A status poll is another cause, with its own line.
    3.times { poll.call }
    assert_equal 2, rate_limit_lines.length
    assert_includes rate_limit_lines.last, "path=order reason=backoff used=0 gate=50"

    @now = NOW + 59
    refused(service)
    poll.call
    assert_equal 2, rate_limit_lines.length
    @now = NOW + 60
    refused(service)
    assert_equal 3, rate_limit_lines.length
    assert_equal 0, @wallet.invoices
  end

  def test_a_provider_429_is_logged_with_its_own_words_and_then_the_stand_off
    routes = {
      "ccies" => { "ccies" => SAMPLE_CCIES },
      "create" => -> { { status: 429, body: JSON.generate("code" => 429, "msg" => "Too many requests") } }
    }
    provider, calls = make_provider(routes)
    service = service_for(provider)
    refused(service)
    assert_equal 1, rate_limit_lines.length
    assert_match(/\Aswap\.provider\.rate_limited: The swap provider answered 429 \(rate limited\); new calls stand off until its wait is over\. \(.*Too many requests\)\z/,
                 rate_limit_lines.first)
    # The next presses make no invoice and no provider call: the guard is
    # standing off, and says so once.
    2.times { refused(service) }
    assert_equal 1, calls.count { |call| call[:path] == "create" }
    assert_equal 1, @wallet.invoices
    assert_equal 2, rate_limit_lines.length
    assert_includes rate_limit_lines.last, "reason=backoff"
    assert_includes rate_limit_lines.last, "backoff_until=#{NOW + 60}"
  end

  def test_no_logger_means_no_line_and_the_same_answer
    provider = AskingProvider.new
    service = OpenReceive::Server::Service.new(
      nwc_client: @wallet, swap_providers: [provider], price_provider: false, clock: -> { @now }
    )
    4.times { provider.budget.reserve("create") }
    refused(service)
  end
end
