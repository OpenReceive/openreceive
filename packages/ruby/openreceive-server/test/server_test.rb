# frozen_string_literal: true

require "minitest/autorun"
require "openreceive/server"
require "stringio"

class FailClosedPreflightTest < Minitest::Test
  class ReceiveOnlyWallet
    def make_invoice(_request) = {}
    def list_transactions(_request) = { "transactions" => [] }
  end

  class SpendCapableWallet < ReceiveOnlyWallet
    def initialize(methods_key: "methods", methods: %w[make_invoice list_transactions pay_invoice multi_pay_invoice])
      @info = { methods_key => methods }
    end

    def get_info
      @info
    end
  end

  class CamelCaseServiceInfoWallet < ReceiveOnlyWallet
    def getWalletServiceInfo # rubocop:disable Naming/MethodName
      { "result" => { "capabilities" => %w[makeInvoice listTransactions payInvoice] } }
    end
  end

  class UnreadableInfoWallet < ReceiveOnlyWallet
    def get_info
      raise "relay timeout"
    end
  end

  class UnsupportedEncryptionWallet < ReceiveOnlyWallet
    def get_info
      { "methods" => %w[make_invoice list_transactions], "encryption" => %w[nip99] }
    end
  end

  def build_service(wallet, **options)
    OpenReceive::Server::Service.new(nwc_client: wallet, clock: -> { 1000 }, **options)
  end

  def test_boot_refuses_a_spend_capable_connection
    error = assert_raises(OpenReceive::Server::SpendCapableWalletError) do
      build_service(SpendCapableWallet.new)
    end
    assert_match(/pay_invoice/, error.message)
    assert_match(/OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC/, error.message)
  end

  def test_boot_refuses_camel_case_capabilities
    assert_raises(OpenReceive::Server::SpendCapableWalletError) do
      build_service(CamelCaseServiceInfoWallet.new)
    end
  end

  def test_config_override_allows_a_spend_capable_connection
    assert build_service(SpendCapableWallet.new, allow_spend_capable_wallet: true)
  end

  def test_env_override_allows_a_spend_capable_connection
    ENV["OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC"] = "yes"
    assert build_service(SpendCapableWallet.new)
  ensure
    ENV.delete("OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC")
  end

  def test_non_truthy_env_value_still_refuses
    ENV["OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC"] = "0"
    assert_raises(OpenReceive::Server::SpendCapableWalletError) do
      build_service(SpendCapableWallet.new)
    end
  ensure
    ENV.delete("OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC")
  end

  def test_boot_fails_closed_when_capabilities_cannot_be_read
    error = assert_raises(OpenReceive::Server::WalletPreflightError) do
      build_service(UnreadableInfoWallet.new)
    end
    assert_match(/could not read wallet info/, error.message)
    assert_match(/relay timeout/, error.message)
  end

  def test_read_failure_fails_closed_even_with_the_spend_override
    assert_raises(OpenReceive::Server::WalletPreflightError) do
      build_service(UnreadableInfoWallet.new, allow_spend_capable_wallet: true)
    end
  end

  def test_boot_proceeds_when_the_client_has_no_info_method
    assert build_service(ReceiveOnlyWallet.new)
  end

  def test_boot_refuses_a_wallet_that_cannot_receive
    error = assert_raises(OpenReceive::Server::WalletPreflightError) do
      build_service(SpendCapableWallet.new(methods: %w[get_info get_balance]))
    end
    assert_match(/make_invoice and list_transactions/, error.message)
  end

  def test_receive_readiness_is_enforced_even_with_the_spend_override
    assert_raises(OpenReceive::Server::WalletPreflightError) do
      build_service(SpendCapableWallet.new(methods: %w[pay_invoice]), allow_spend_capable_wallet: true)
    end
  end

  def test_boot_refuses_an_unsupported_encryption_mode
    wallet = UnsupportedEncryptionWallet.new
    error = assert_raises(OpenReceive::Server::WalletPreflightError) do
      build_service(wallet)
    end
    assert_match(/encryption/, error.message)
  end

  def test_receive_only_capabilities_boot_normally
    assert build_service(SpendCapableWallet.new(methods: %w[make_invoice list_transactions get_info]))
  end
end

class StorageFreeServerTest < Minitest::Test
  class Wallet
    attr_reader :transactions

    def initialize
      @counter = 0
      @transactions = []
    end

    def make_invoice(request)
      @counter += 1
      hash = @counter.to_s(16).rjust(64, "0")
      @transactions << {
        "type" => "incoming", "payment_hash" => hash, "invoice" => "ln-test-#{@counter}",
        "amount_msats" => request.fetch("amount_msats"), "transaction_state" => "pending",
        "created_at" => 1000
      }
      { "invoice" => "ln-test-#{@counter}", "payment_hash" => hash,
        "amount_msats" => request.fetch("amount_msats"), "created_at" => 1000, "expires_at" => 1600 }
    end

    def list_transactions(request)
      rows = @transactions.slice(request.fetch("offset", 0), request.fetch("limit", 20)) || []
      { "transactions" => rows }
    end
  end

  class SwapProvider
    attr_reader :order

    def name
      "test-swap"
    end

    def supported_pay_in_assets
      ["USDT_TRON"]
    end

    def invoice_expiry_seconds(pay_in_asset:)
      600
    end

    def create_swap(_input)
      @order = {
        "provider" => name,
        "provider_order_id" => "ruby-swap-1",
        "pay_in_asset" => "USDT_TRON",
        "deposit_address" => "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
        "deposit_amount" => "1.05",
        "state" => "awaiting_deposit",
        "expires_at" => 1500
      }
    end

    def get_status(_stored_order)
      @order.dup
    end

    def request_refund(_current_order, _address)
      @order["state"] = "refund_pending"
    end

    def force_refund_required
      @order["state"] = "refund_required"
    end
  end

  def setup
    @wallet = Wallet.new
    @service = OpenReceive::Server::Service.new(
      nwc_client: @wallet,
      price_provider: Struct.new(:unused) do
        def btc_fiat_price(_currency)
          "50000.00"
        end
      end.new,
      clock: -> { 1000 }
    )
  end

  def test_lsc_uri_shared_vectors
    vectors = JSON.parse(File.read("spec/test-vectors/lsc-uri.json"))
    vectors.fetch("valid").each do |vector|
      assert_equal vector.fetch("expected"), OpenReceive::Server::LscUri.parse(vector.fetch("uri")), vector.fetch("name")
    end
    vectors.fetch("invalid").each do |vector|
      assert_raises(ArgumentError, vector.fetch("name")) do
        OpenReceive::Server::LscUri.parse(vector.fetch("uri"))
      end
    end
  end

  def test_config_reads_only_secret_environment_variables
    env = {
      "NWC_URI" => "nostr+walletconnect://example",
      "LSC_URI_PRIMARY" => "lightning+swapconnect://ff.example/?key=k&secret=s"
    }
    config = OpenReceive::Server::Config.load(env: env)
    assert_equal env.fetch("NWC_URI"), config.nwc
    assert_equal 1, config.lsc_connections.length
    refute_includes config.inspect, env.fetch("NWC_URI")
    refute_includes config.to_h.to_s, "secret=s"
  end

  def test_checkout_and_payment_check_are_storage_free
    checkout = @service.create_checkout("order_id" => "ruby-1", "amount" => { "sats" => 1000 })
    refute_respond_to @service, :store
    assert_equal "pending", @service.check_payment(
      "payment_hash" => checkout["payment_hash"],
      "created_at" => checkout["created_at"]
    )["status"]
    @wallet.transactions.first["transaction_state"] = "settled"
    @wallet.transactions.first["settled_at"] = 1010
    assert_equal 1010, @service.check_payment(
      "payment_hash" => checkout["payment_hash"],
      "created_at" => checkout["created_at"]
    )["paid_at"]
  end

  def test_create_checkout_fails_closed_when_wallet_ignores_requested_expiry
    wallet = Class.new do
      attr_reader :last_request

      def make_invoice(request)
        @last_request = request
        hash = "a" * 64
        {
          "invoice" => "ln-long-expiry",
          "payment_hash" => hash,
          "amount_msats" => request.fetch("amount_msats"),
          "created_at" => 1000,
          # Simulate wallets that ignore expiry and mint a 60-minute invoice.
          "expires_at" => 4600
        }
      end

      def list_transactions(_request)
        { "transactions" => [] }
      end
    end.new
    service = OpenReceive::Server::Service.new(nwc_client: wallet, clock: -> { 1000 })

    error = assert_raises(OpenReceive::Server::WalletContractError) do
      service.create_checkout("order_id" => "ruby-expiry", "amount" => { "sats" => 1000 })
    end

    assert_equal 600, wallet.last_request.fetch("expiry")
    assert_equal 502, error.status
    assert_equal "UNSUPPORTED_METHOD", error.code
    assert_match(/did not honor the requested invoice expiry/, error.message)
  end

  def test_handler_commits_before_returning_invoice
    committed = []
    handler = OpenReceive::Server::RequestHandler.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: ->(**_context) { { "amount" => { "sats" => 5 } } },
      on_checkout_created: ->(**payment) { committed << payment },
      on_paid: ->(_payment) {}
    )
    status, _headers, body = handler.create_checkout(
      raw_body: JSON.generate("order_id" => "ruby-http"),
      request: {}, request_id: "req-1"
    )
    assert_equal 201, status
    assert_equal body.dig("checkout", "payment_hash"), committed.first.fetch(:payment_hash)
    refute body.key?("order_access_token")
  end

  def test_handler_reuses_host_rows_live_payment_hash
    committed = nil
    handler = OpenReceive::Server::RequestHandler.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: lambda do |**_context|
        {
          "amount" => { "sats" => 5 },
          "payment_hash" => committed&.fetch(:payment_hash),
          "checkout" => committed&.fetch(:checkout)
        }.compact
      end,
      on_checkout_created: ->(**payment) { committed = payment },
      on_paid: ->(_payment) {}
    )
    request = { raw_body: JSON.generate("order_id" => "ruby-retry"), request: {} }
    first = handler.create_checkout(**request, request_id: "req-a")
    second = handler.create_checkout(**request, request_id: "req-b")
    assert_equal 201, first.first
    assert_equal 201, second.first
    assert_equal first.last.dig("checkout", "payment_hash"), second.last.dig("checkout", "payment_hash")
    assert_equal 1, @wallet.transactions.length
  end

  def test_handler_checks_the_exact_host_owned_payment_attempt
    checkout = @service.create_checkout("order_id" => "ruby-check", "amount" => { "sats" => 5 })
    selected_hash = checkout.fetch("payment_hash")
    delivered = []
    handler = OpenReceive::Server::RequestHandler.new(
      service: @service,
      authorize: ->(context) { context.dig(:resource, :payment_hash) == selected_hash },
      resolve_checkout: lambda do |input:, **|
        {
          "amount" => { "sats" => 5 },
          "payment_hash" => input.fetch("payment_hash"),
          "checkout" => checkout
        }
      end,
      on_checkout_created: ->(**_payment) {},
      on_paid: ->(payment) { delivered << payment }
    )
    @wallet.transactions.first["transaction_state"] = "settled"
    @wallet.transactions.first["settled_at"] = 1010
    status, _headers, body = handler.check_payment(
      raw_body: JSON.generate(
        "order_id" => "ruby-check",
        "payment_hash" => selected_hash
      ),
      request: {},
      request_id: "req-check"
    )
    assert_equal 200, status
    assert_equal selected_hash, body.fetch("payment_hash")
    assert_equal selected_hash, delivered.first.fetch("payment_hash")
  end

  def test_select_provider_fails_over_only_when_primary_is_down
    down = Class.new do
      def name = "primary-down"
      def supported_pay_in_assets = raise "primary unavailable"
    end.new
    backup = SwapProvider.new
    service = OpenReceive::Server::Service.new(
      nwc_client: @wallet,
      price_provider: nil,
      swap_providers: [down, backup],
      clock: -> { 1000 }
    )
    swap = service.create_swap(
      "order_id" => "ruby-failover",
      "amount" => { "sats" => 20_000 },
      "pay_in_asset" => "USDT_TRON"
    )
    assert_equal "test-swap", swap.fetch("provider")
  end

  def test_select_provider_does_not_use_backup_when_primary_omits_asset
    primary = Class.new do
      def name = "primary-ok"
      def supported_pay_in_assets = ["SOL_SOL"]
    end.new
    backup = SwapProvider.new
    service = OpenReceive::Server::Service.new(
      nwc_client: @wallet,
      price_provider: nil,
      swap_providers: [primary, backup],
      clock: -> { 1000 }
    )
    error = assert_raises(OpenReceive::Server::ServiceError) do
      service.create_swap(
        "order_id" => "ruby-no-failover",
        "amount" => { "sats" => 20_000 },
        "pay_in_asset" => "USDT_TRON"
      )
    end
    # JS-parity wire mapping: 503 INTERNAL with the selectProvider message.
    assert_equal 503, error.status
    assert_equal "INTERNAL", error.code
    assert_equal "No configured swap provider supports USDT_TRON.", error.message
  end

  def test_host_serialized_swap_data_recovers_state_and_controls_refunds
    provider = SwapProvider.new
    service = OpenReceive::Server::Service.new(
      nwc_client: @wallet,
      price_provider: nil,
      swap_providers: [provider],
      clock: -> { 1000 }
    )
    swap = service.create_swap(
      "order_id" => "ruby-swap",
      "amount" => { "sats" => 20_000 },
      "pay_in_asset" => "USDT_TRON"
    )
    stored = JSON.parse(JSON.generate(swap.fetch("swap_data")))
    refute stored.key?("payment_hash")
    refute stored.key?("order_id")

    provider.force_refund_required
    assert_equal "refund_required", service.get_swap(
      order_id: swap.fetch("order_id"), payment_hash: swap.fetch("payment_hash"), swap_data: stored
    ).fetch("provider_state")
    refunded = service.refund_swap(
      order_id: swap.fetch("order_id"),
      payment_hash: swap.fetch("payment_hash"),
      swap_data: stored,
      refund_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
    )
    assert_equal "refund_pending", refunded.fetch("provider_state")
    refute refunded.key?("swap_data")
  end

  # A settled payments/check body must never leak wallet secrets: the raw
  # transaction's preimage, invoice, and any other non-whitelisted field stay
  # server-side (mirrors the JS publicPaymentDetails whitelist).
  def test_settled_payment_check_exposes_only_public_wallet_details
    checkout = @service.create_checkout("order_id" => "ruby-public", "amount" => { "sats" => 5 })
    hash = checkout.fetch("payment_hash")
    handler = OpenReceive::Server::RequestHandler.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: lambda do |**_context|
        { "amount" => { "sats" => 5 }, "payment_hash" => hash, "checkout" => checkout }
      end,
      on_checkout_created: ->(**_payment) {},
      on_paid: ->(_payment) {}
    )
    row = @wallet.transactions.first
    row["transaction_state"] = "settled"
    row["settled_at"] = 1010
    row["preimage"] = "2" * 64
    status, _headers, body = handler.check_payment(
      raw_body: JSON.generate("order_id" => "ruby-public", "payment_hash" => hash),
      request: {},
      request_id: "req-public"
    )
    assert_equal 200, status
    assert_equal "settled", body.fetch("status")
    details = body.fetch("details")
    transaction = details.fetch("transaction")
    refute transaction.key?("preimage"), "preimage must never reach the payer"
    refute transaction.key?("invoice"), "the raw invoice must never reach the payer"
    assert_empty transaction.keys -
                 %w[payment_hash transaction_state amount_msats fees_paid_msats created_at settled_at expires_at],
                 "only whitelisted transaction fields may appear"
    assert_equal hash, transaction.fetch("payment_hash")
    assert_equal 1010, transaction.fetch("settled_at")
    # The whitelist exists to expose the settled amount; the old key names
    # (`amount`, `fees_paid`) never existed on a normalized transaction.
    assert_equal 5000, transaction.fetch("amount_msats")
    assert_equal 1000, details.fetch("observed_at")
    assert_equal "settled_at", details.fetch("paid_at_source")
    assert_empty details.keys - %w[transaction observed_at paid_at_source]
    refute JSON.generate(body).include?("2" * 64)
  end

  # Payer input is shape-validated before any host hook runs: a malformed
  # payment_hash must be rejected 400 without invoking authorize, rate_limit,
  # or resolve_checkout (mirrors JS requiredPaymentHash placement).
  def test_malformed_payment_hash_is_rejected_before_host_hooks
    calls = []
    handler = OpenReceive::Server::RequestHandler.new(
      service: @service,
      authorize: lambda do |_context|
        calls << :authorize
        true
      end,
      resolve_checkout: lambda do |**_context|
        calls << :resolve
        { "amount" => { "sats" => 5 } }
      end,
      on_checkout_created: ->(**_payment) {},
      on_paid: ->(_payment) {},
      rate_limit: lambda do |_context|
        calls << :rate_limit
        true
      end
    )
    raw = JSON.generate("order_id" => "ruby-shape", "payment_hash" => "not-a-hash")
    [
      handler.check_payment(raw_body: raw, request: {}, request_id: "req-shape-check"),
      handler.get_swap(raw_body: raw, request: {}, request_id: "req-shape-read"),
      handler.refund_swap(raw_body: raw, request: {}, request_id: "req-shape-refund")
    ].each do |status, _headers, body|
      assert_equal 400, status
      assert_equal "INVALID_REQUEST", body.fetch("code")
      assert_equal "payment_hash must be 64 hexadecimal characters.", body.fetch("message")
    end
    assert_empty calls, "host hooks must not run for a malformed payment_hash"
  end

  def build_rack_app
    OpenReceive::Server::RackApp.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: ->(**_context) { { "amount" => { "sats" => 1 } } },
      on_checkout_created: ->(**_payment) {},
      on_paid: ->(_payment) {}
    )
  end

  def rack_call(app, method, path)
    status, headers, body = app.call(
      "REQUEST_METHOD" => method,
      "PATH_INFO" => path,
      "QUERY_STRING" => "",
      "rack.input" => StringIO.new("")
    )
    [status, headers, JSON.parse(body.join)]
  end

  # A known path with the wrong method is 405 INVALID_REQUEST (no Allow
  # header), never 404 — mirrors the JS router.
  def test_known_path_with_wrong_method_is_405
    app = build_rack_app
    [["GET", "/openreceive/checkouts"], ["POST", "/openreceive/rates"],
     ["DELETE", "/openreceive/swaps/status"]].each do |method, path|
      status, headers, body = rack_call(app, method, path)
      assert_equal 405, status, "#{method} #{path}"
      assert_equal "INVALID_REQUEST", body.fetch("code")
      assert_equal "This OpenReceive route does not support that HTTP method.", body.fetch("message")
      refute headers.keys.any? { |key| key.downcase == "allow" }, "JS sets no Allow header"
    end

    status, _headers, body = rack_call(app, "GET", "/openreceive/unknown")
    assert_equal 404, status
    assert_equal "NOT_FOUND", body.fetch("code")
  end

  # Infrastructure failing to persist the attempt is a retryable 503 INTERNAL
  # (mirrors JS); meaningful repository refusals keep their own status/code.
  def test_persistence_failure_withholds_the_invoice_with_a_retryable_503
    handler = OpenReceive::Server::RequestHandler.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: ->(**_context) { { "amount" => { "sats" => 5 } } },
      on_checkout_created: ->(**_payment) { raise "database unavailable" },
      on_paid: ->(_payment) {}
    )
    status, _headers, body = handler.create_checkout(
      raw_body: JSON.generate("order_id" => "ruby-persist"),
      request: {}, request_id: "req-persist"
    )
    assert_equal 503, status
    assert_equal "INTERNAL", body.fetch("code")
    assert_equal true, body.fetch("retryable")
    refute body.key?("checkout"), "the invoice is withheld"
    assert_match(/could not persist this payment attempt/, body.fetch("message"))

    conflicting = OpenReceive::Server::RequestHandler.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: ->(**_context) { { "amount" => { "sats" => 5 } } },
      on_checkout_created: lambda do |**_payment|
        raise OpenReceive::Server::ConflictError,
              "This order already has a live payment attempt for the same method."
      end,
      on_paid: ->(_payment) {}
    )
    status, _headers, body = conflicting.create_checkout(
      raw_body: JSON.generate("order_id" => "ruby-conflict"),
      request: {}, request_id: "req-conflict"
    )
    assert_equal 409, status
    assert_equal "CONFLICT", body.fetch("code")
    assert_match(/live payment attempt/, body.fetch("message"))
  end

  # A host order resolved without an amount is a host-integration bug: 500
  # INTERNAL with the JS handler's exact message (not a payer-facing 404).
  def test_missing_host_amount_is_a_500_internal
    handler = OpenReceive::Server::RequestHandler.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: ->(**_context) { {} },
      on_checkout_created: ->(**_payment) {},
      on_paid: ->(_payment) {}
    )
    %i[prepare_checkout create_checkout].each do |action|
      status, _headers, body = handler.public_send(
        action,
        raw_body: JSON.generate("order_id" => "ruby-no-amount"),
        request: {}, request_id: "req-no-amount"
      )
      assert_equal 500, status, action.to_s
      assert_equal "INTERNAL", body.fetch("code")
      assert_equal "The host resolved this order without an amount.", body.fetch("message")
    end
  end

  # Unexpected exceptions still redact to the generic 500 message.
  def test_unexpected_errors_stay_redacted
    handler = OpenReceive::Server::RequestHandler.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: ->(**_context) { raise "secret internal detail" },
      on_checkout_created: ->(**_payment) {},
      on_paid: ->(_payment) {}
    )
    status, _headers, body = handler.create_checkout(
      raw_body: JSON.generate("order_id" => "ruby-redacted"),
      request: {}, request_id: "req-redacted"
    )
    assert_equal 500, status
    assert_equal "Internal server error.", body.fetch("message")
  end

  # Full-body golden comparison (schema_version 2). Placeholder strings in a
  # vector's expected body/headers assert "present and matching this pattern"
  # for values that legitimately differ per run; everything else — key set AND
  # values — must match exactly in both engines. Mirrored in
  # tests/http-boundaries.test.mjs; change both together.
  GOLDEN_PLACEHOLDERS = {
    "<request_id>" => lambda { |value|
      value.is_a?(String) &&
        value.match?(/\Areq_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/)
    },
    "<payment_hash>" => ->(value) { value.is_a?(String) && value.match?(/\A[0-9a-f]{64}\z/) },
    "<bolt11>" => ->(value) { value.is_a?(String) && value.start_with?("ln") },
    "<unix_seconds>" => ->(value) { value.is_a?(Integer) && value >= 0 }
  }.freeze

  def assert_golden_value(actual, expected, context)
    if expected.is_a?(String) && GOLDEN_PLACEHOLDERS.key?(expected)
      assert GOLDEN_PLACEHOLDERS.fetch(expected).call(actual),
             "#{context}: #{actual.inspect} does not satisfy #{expected}"
    elsif expected.is_a?(Array)
      assert_kind_of Array, actual, "#{context}: expected an array"
      assert_equal expected.length, actual.length, "#{context}: array length"
      expected.each_with_index do |item, index|
        assert_golden_value(actual[index], item, "#{context}[#{index}]")
      end
    elsif expected.is_a?(Hash)
      assert_kind_of Hash, actual, "#{context}: expected an object"
      assert_equal expected.keys.sort, actual.keys.sort, "#{context}: key set"
      expected.each { |key, item| assert_golden_value(actual[key], item, "#{context}.#{key}") }
    elsif expected.nil?
      assert_nil actual, "#{context}: value"
    else
      assert_equal expected, actual, "#{context}: value"
    end
  end

  def test_rack_handler_satisfies_http_golden_vectors
    build_app = lambda do |rate_limit|
      OpenReceive::Server::RackApp.new(
        service: @service,
        authorize: ->(_context) { true },
        resolve_checkout: ->(**_context) { { "amount" => { "sats" => 1 } } },
        on_checkout_created: ->(**_payment) {},
        on_paid: ->(_payment) {},
        rate_limit: rate_limit
      )
    end
    # Deterministic settled attempt behind the settled_check golden vector:
    # the wallet transaction deliberately carries the preimage and raw
    # invoice, and the vector's exact key-set assertion proves the engine
    # never leaks them into the payer-polled body. Mirrors the JS harness.
    settled_hash = "7f" * 32
    settled_row = {
      "type" => "incoming",
      "invoice" => "lnbcgoldensettled",
      "payment_hash" => settled_hash,
      "amount_msats" => 1000,
      "transaction_state" => "settled",
      "created_at" => 900,
      "expires_at" => 1500,
      "settled_at" => 950,
      "preimage" => "1" * 64
    }
    settled_wallet = Class.new do
      def initialize(row)
        @row = row
      end

      def make_invoice(_request)
        raise "the settled_check golden handler mints nothing"
      end

      def list_transactions(_request)
        { "transactions" => [@row] }
      end
    end.new(settled_row)
    settled_checkout = {
      "order_id" => "order-golden-settled",
      "payment_hash" => settled_hash,
      "bolt11" => "lnbcgoldensettled",
      "amount_msats" => 1000,
      "created_at" => 900,
      "expires_at" => 1500,
      "fiat_quote" => nil
    }
    settled_app = OpenReceive::Server::RackApp.new(
      service: OpenReceive::Server::Service.new(nwc_client: settled_wallet, clock: -> { 1000 }),
      authorize: ->(_context) { true },
      resolve_checkout: lambda do |**_context|
        { "amount" => { "sats" => 1 }, "payment_hash" => settled_hash, "checkout" => settled_checkout }
      end,
      on_checkout_created: ->(**_payment) {},
      on_paid: ->(_payment) {}
    )
    apps = {
      "default" => build_app.call(nil),
      "rate_limited" => build_app.call(->(_context) { false }),
      "settled_check" => settled_app
    }
    Dir["spec/test-vectors/http-golden/*.json"].sort.each do |path|
      vector = JSON.parse(File.read(path))
      assert_equal 2, vector["schema_version"], "#{path}: schema_version"
      request = vector.fetch("request")
      app = apps.fetch(vector["handler"] || "default")
      status, headers, body = app.call(
        "REQUEST_METHOD" => request.fetch("method"),
        "PATH_INFO" => request.fetch("path"),
        "QUERY_STRING" => "",
        # `body_bytes` synthesizes an oversized raw body so the vector does not
        # have to inline 64KB of JSON.
        "rack.input" => StringIO.new(golden_request_body(request))
      )
      name = vector.fetch("name")
      assert_equal vector.dig("expected", "status"), status, name
      vector.dig("expected", "headers")&.each do |header, value|
        actual = headers.find { |key, _| key.downcase == header.downcase }&.last
        assert_golden_value(actual, value, "#{name}: header #{header}")
      end
      # The whole wire body, not a code sample: an extra or missing field in
      # either engine fails the run.
      assert_golden_value(JSON.parse(body.join), vector.fetch("expected").fetch("body"), "#{name}: body")
    end
  end

    def golden_request_body(request)
      return "x" * Integer(request.fetch("body_bytes")) if request.key?("body_bytes")
      request.key?("body") ? JSON.generate(request["body"]) : ""
    end
end

# Mirrors the JS openReceiveClientIpBucket cases in
# tests/rate-limit.test.mjs; the same input must produce the same bucket
# string in both engines. Change both together.
class ClientIpBucketTest < Minitest::Test
  def bucket(ip)
    OpenReceive::Server::ClientIp.bucket(ip)
  end

  def test_bucket_collapses_v4_mapped_and_buckets_ipv6_by_64
    assert_equal "203.0.113.9", bucket("203.0.113.9")
    assert_equal "203.0.113.9", bucket("::ffff:203.0.113.9")
    assert_equal "2001:db8:1:2::/64", bucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
    # Rotating privacy addresses inside one /64 share a single budget.
    assert_equal bucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd"),
                 bucket("2001:db8:1:2:1111:2222:3333:4444")
    assert_equal "2001:db8:0:0::/64", bucket("2001:db8::1")
    # Idempotent: bucketing a bucket changes nothing.
    assert_equal "2001:db8:1:2::/64", bucket("2001:db8:1:2::/64")
    # Unparsable input passes through so the limit still gets a consistent key.
    assert_equal "not-an-ip:zz", bucket("not-an-ip:zz")
  end

  def test_attributed_fails_open_without_an_ip
    assert_nil OpenReceive::Server::ClientIp.attributed(nil)
    assert_nil OpenReceive::Server::ClientIp.attributed("")
    assert_nil OpenReceive::Server::ClientIp.attributed("   ")
    assert_equal "2001:db8:1:2::/64",
                 OpenReceive::Server::ClientIp.attributed("2001:DB8:1:2:AAAA:BBBB:CCCC:DDDD")
  end
end
