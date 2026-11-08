# frozen_string_literal: true

# A shop with no swap provider configured takes Lightning payments end to end.
#
# Every test boots the real Service from an environment with no usable
# LSC_URI_* value (`${LSC_URI_PRIMARY:-}` in Compose and a half-filled .env
# read as blank, and blank means "not configured") and drives the real HTTP
# routes through RackApp with a fake wallet.

require "minitest/autorun"
require "json"
require "logger"
require "stringio"
require "openreceive/server"

class NoSwapProviderTest < Minitest::Test
  # 1 sat is below every swap provider's minimum and 2 BTC above every maximum;
  # neither limit may touch a Lightning invoice.
  ORDERS = { "order-no-swap" => 2_100, "order-tiny" => 1, "order-huge" => 200_000_000 }.freeze
  ENVIRONMENTS = {
    "no LSC_URI variables" => {},
    "LSC_URI_* empty" => { "LSC_URI_PRIMARY" => "", "LSC_URI_BACKUP" => "" },
    "LSC_URI_* whitespace" => { "LSC_URI_PRIMARY" => "   ", "LSC_URI_BACKUP" => "\t\n " }
  }.freeze
  NO_PROVIDER_MESSAGE = "No configured swap provider supports USDT_TRON."
  NO_SWAP_DATA_MESSAGE = "The host order has no swap data."

  # A receive-only wallet in the shape nwc-ruby answers: mints invoices and
  # lists them; `settle!` marks one paid so a scan sees it settled.
  class Wallet
    attr_reader :invoices

    def initialize(clock)
      @clock = clock
      @invoices = []
      @counter = 0
    end

    def get_info = { "methods" => %w[make_invoice list_transactions], "encryption" => %w[nip04] }

    def make_invoice(request)
      @counter += 1
      hash = @counter.to_s(16).rjust(64, "0")
      now = @clock.call
      record = { "type" => "incoming", "invoice" => "lnbc#{@counter}", "payment_hash" => hash,
                 "amount_msats" => request.fetch("amount_msats"), "created_at" => now,
                 "expires_at" => now + request.fetch("expiry", 600), "transaction_state" => "pending" }
      @invoices << record
      record.slice("invoice", "payment_hash", "amount_msats", "created_at", "expires_at")
    end

    def list_transactions(request)
      rows = @invoices.select { |row| row["transaction_state"] == "settled" || request["unpaid"] }
      { "transactions" => rows.slice(request.fetch("offset", 0), request.fetch("limit", 50)) || [] }
    end

    def settle!(hash, at:)
      row = @invoices.find { |candidate| candidate["payment_hash"] == hash }
      row.merge!("transaction_state" => "settled", "settled_at" => at, "preimage" => "1" * 64)
    end
  end

  def setup
    @now = 1_700_000_000
    @log = StringIO.new
    @logger = Logger.new(@log)
    @logger.formatter = ->(severity, _time, _progname, message) { "#{severity} #{message}\n" }
    @wallet = Wallet.new(-> { @now })
    @committed = {}
    @paid = []
  end

  def boot(env)
    @service = OpenReceive::Server::Service.new(
      nwc_client: @wallet, env: env, clock: -> { @now },
      price_provider: OpenReceive::Rates::StaticPriceProvider.new, logger: @logger
    )
    @app = OpenReceive::Server::RackApp.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: method(:resolve_checkout),
      on_checkout_created: ->(reference:, payment_hash:, checkout:, swap_data:, client_ip:) { @committed[reference] = checkout },
      on_paid: ->(payment) { @paid << payment.fetch("payment_hash") }
    )
  end

  # The host resolves the trusted price, and names the committed attempt on the
  # routes that read one back (payments/check and the swap status routes).
  def resolve_checkout(action:, reference:, **)
    sats = ORDERS[reference]
    return { "amount" => nil } if sats.nil?

    resolved = { "amount" => { "sats" => sats } }
    checkout = @committed[reference]
    if checkout && %w[payment.check swap.read swap.refund].include?(action)
      resolved.merge!("payment_hash" => checkout.fetch("payment_hash"), "checkout" => checkout)
    end
    resolved
  end

  def post(route, body)
    status, _headers, response = @app.call(
      "REQUEST_METHOD" => "POST", "PATH_INFO" => "/openreceive#{route}", "QUERY_STRING" => "",
      "CONTENT_TYPE" => "application/json",
      "rack.input" => StringIO.new(JSON.generate(body))
    )
    [status, JSON.parse(response.join)]
  end

  def provider_complaints
    @log.string.lines.grep(/swap|lsc|provider/i)
  end

  ENVIRONMENTS.each do |label, env|
    tag = label.gsub(/\W+/, "_")

    define_method("test_no_swap_provider_#{tag}_boot_is_quiet_and_builds_no_provider") do
      boot(env)
      assert_equal [], @service.list_swap_options(amount_msats: 2_100_000)
      # Config is the other reader of the environment (doctor and hosts that load settings).
      assert_empty OpenReceive::Server::Config.load(env: env).lsc_connections
      assert_empty provider_complaints
    end

    define_method("test_no_swap_provider_#{tag}_prepare_mint_settle_and_paid_hook_fire_once") do
      boot(env)
      status, prepared = post("/checkouts/prepare", "reference" => "order-no-swap")
      assert_equal 200, status, prepared
      assert_equal 2_100_000, prepared.fetch("amount_msats")
      assert_equal [], prepared.fetch("payment_methods")
      assert_empty @wallet.invoices, "prepare mints nothing"

      status, created = post("/checkouts", "reference" => "order-no-swap")
      assert_equal 201, status, created
      checkout = created.fetch("checkout")
      assert_match(/\Alnbc/, checkout.fetch("bolt11"))
      assert_match(/\A[0-9a-f]{64}\z/, checkout.fetch("payment_hash"))
      assert_equal 2_100_000, checkout.fetch("amount_msats")
      # The wire keeps the (empty) catalog, so a client's picker can stop loading.
      assert_equal [], created.fetch("payment_methods")
      assert_equal 1, @wallet.invoices.length
      assert_equal 2_100_000, @wallet.invoices.first.fetch("amount_msats")

      check = { "reference" => "order-no-swap", "payment_hash" => checkout.fetch("payment_hash") }
      status, pending = post("/payments/check", check)
      assert_equal 200, status, pending
      assert_equal "pending", pending.fetch("status")
      assert_equal [], pending.fetch("payment_methods")

      @wallet.settle!(checkout.fetch("payment_hash"), at: @now + 1)
      status, settled = post("/payments/check", check)
      assert_equal 200, status, settled
      assert_equal "settled", settled.fetch("status")
      assert_equal "settled", post("/payments/check", check).last.fetch("status")
      # RackApp owns no payments table (see the README): replay-safe settlement
      # is the host's job, so on_paid is delivered for the one settled payment
      # on every settled check. The Rails engine test pins exactly-once.
      assert_equal [checkout.fetch("payment_hash")], @paid.uniq
      assert_empty provider_complaints
    end

    define_method("test_no_swap_provider_#{tag}_amounts_past_any_swap_limit_mint_exactly") do
      boot(env)
      { "order-tiny" => 1_000, "order-huge" => 200_000_000_000 }.each do |reference, msats|
        status, created = post("/checkouts", "reference" => reference)
        assert_equal 201, status, created
        assert_equal msats, created.fetch("checkout").fetch("amount_msats")
        assert_equal [], created.fetch("payment_methods")
      end
    end

    define_method("test_no_swap_provider_#{tag}_swap_routes_refuse_cleanly_and_never_reach_the_wallet") do
      boot(env)
      ["/swaps/quote", "/swaps"].each do |route|
        status, body = post(route, "reference" => "order-no-swap", "pay_in_asset" => "USDT_TRON")
        assert_equal 503, status, [route, body]
        assert_equal "INTERNAL", body.fetch("code")
        assert_equal NO_PROVIDER_MESSAGE, body.fetch("message")
      end
      assert_empty @wallet.invoices, "a refused swap mints no invoice"

      # Status and refund need an attempt to read, so mint one and ask about it.
      _status, created = post("/checkouts", "reference" => "order-no-swap")
      hash = created.fetch("checkout").fetch("payment_hash")
      { "/swaps/status" => {}, "/swaps/refunds" => { "refund_address" => "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb" } }.each do |route, extra|
        status, body = post(route, { "reference" => "order-no-swap", "payment_hash" => hash }.merge(extra))
        assert_equal 404, status, [route, body]
        assert_equal "NOT_FOUND", body.fetch("code")
        assert_equal NO_SWAP_DATA_MESSAGE, body.fetch("message")
      end
      assert_equal 1, @wallet.invoices.length, "refused swap routes mint nothing"
      assert_empty provider_complaints
    end

    define_method("test_no_swap_provider_#{tag}_rates_answer_so_a_checkout_cannot_hang") do
      boot(env)
      status, _headers, body = @app.call(
        "REQUEST_METHOD" => "GET", "PATH_INFO" => "/openreceive/rates", "QUERY_STRING" => "currencies=USD",
        "CONTENT_TYPE" => "application/json", "rack.input" => StringIO.new("")
      )
      assert_equal 200, status
      assert JSON.parse(body.join).fetch("bitcoin").fetch("usd")
    end
  end
end
