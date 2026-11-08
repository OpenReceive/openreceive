# frozen_string_literal: true

# A Rails shop with no swap provider configured takes Lightning payments end
# to end through the engine's real controllers and its own tables.
#
# The engine reads ENV itself (config.swap_providers stays nil, as the install
# generator leaves it), so a blank LSC_URI_* from a half-filled .env or Compose
# `${LSC_URI_PRIMARY:-}` must read as "not configured", and the opportunistic
# reconcile pass runs exactly as it does in production.

require "minitest/autorun"
require "active_support/testing/time_helpers"
require "json"
require "stringio"
require "securerandom"
require "openreceive/rails"
require "action_controller"
require "active_record"

ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ":memory:")
ActiveRecord::Schema.verbose = false
ActiveRecord::Schema.define do
  create_table :openreceive_payments, force: true do |t|
    t.string :reference, null: false
    t.string :payment_hash, null: false, limit: 64
    t.string :status, null: false, default: "pending"
    t.string :status_reason
    t.datetime :paid_at
    t.datetime :expires_at, null: false
    t.json :checkout_data, null: false
    t.json :swap_data
    t.string :client_ip
    t.datetime :inserted_at, null: false
    t.timestamps
    t.check_constraint "status IN ('pending', 'settled', 'expired', 'failed', 'attention')",
                       name: "openreceive_payments_status_check"
    t.check_constraint "length(payment_hash) = 64 AND payment_hash NOT GLOB '*[^0-9a-f]*'",
                       name: "openreceive_payments_payment_hash_check"
  end
  add_index :openreceive_payments, :payment_hash, unique: true
  add_index :openreceive_payments, [:reference, :created_at]
  add_index :openreceive_payments, [:status, :created_at]
  add_index :openreceive_payments, [:client_ip, :inserted_at]
  create_table :openreceive_meta, id: false, force: true do |t|
    t.string :key, null: false, primary_key: true
    t.text :value, null: false
    t.bigint :rev, null: false, default: 0
  end
  execute(<<~SQL.squish)
    INSERT INTO openreceive_meta (key, value, rev)
    VALUES ('schema_version', '#{OpenReceive::Server::PAYMENTS_SCHEMA_VERSION}', 0)
    ON CONFLICT (key) DO NOTHING
  SQL
end

require_relative "../app/models/open_receive_payment"
require_relative "../app/models/open_receive_meta"
require_relative "../app/controllers/openreceive/application_controller"
require_relative "../app/controllers/openreceive/checkouts_controller"
require_relative "../app/controllers/openreceive/payments_controller"
require_relative "../app/controllers/openreceive/rates_controller"
require_relative "../app/controllers/openreceive/swaps_controller"

class NoSwapProviderRailsTest < Minitest::Test
  include ActiveSupport::Testing::TimeHelpers

  # 1 sat is below every swap provider's minimum and 2 BTC above every maximum.
  ORDERS = { "order-no-swap" => 2_100, "order-tiny" => 1, "order-huge" => 200_000_000 }.freeze
  LSC_NAMES = %w[LSC_URI_PRIMARY LSC_URI_BACKUP].freeze
  ENVIRONMENTS = {
    "no LSC_URI variables" => {},
    "LSC_URI_* empty" => { "LSC_URI_PRIMARY" => "", "LSC_URI_BACKUP" => "" },
    "LSC_URI_* whitespace" => { "LSC_URI_PRIMARY" => "   ", "LSC_URI_BACKUP" => "\t\n " }
  }.freeze

  # A receive-only wallet in nwc-ruby's shape: mints invoices and lists them.
  class Wallet
    attr_reader :invoices

    def initialize
      @invoices = []
      @counter = 0
    end

    def get_info = { "methods" => %w[make_invoice list_transactions], "encryption" => %w[nip04] }

    def make_invoice(request)
      @counter += 1
      hash = @counter.to_s(16).rjust(64, "0")
      now = Time.now.to_i
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
    [OpenReceivePayment].each(&:delete_all)
    OpenReceiveMeta.where.not(key: "schema_version").delete_all
    @saved_env = LSC_NAMES.to_h { |name| [name, ENV[name]] }
    LSC_NAMES.each { |name| ENV.delete(name) }
    @wallet = Wallet.new
    @paid = []
    @log = StringIO.new
  end

  def teardown
    travel_back
    OpenReceive.reset_config!
    @saved_env.each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value }
  end

  # The install-generator shape: amount_for + on_paid + the wallet; no
  # swap_providers, so the service reads LSC_URI_* from ENV.
  def boot(env)
    env.each { |name, value| ENV[name] = value }
    wallet = @wallet
    paid = @paid
    OpenReceive.reset_config!
    OpenReceive.configure do |config|
      config.authorize = ->(_context) { true }
      config.nwc_client = wallet
      config.price_provider = OpenReceive::Rates::StaticPriceProvider.new
      config.amount_for = ->(reference) { ORDERS.key?(reference) ? { "sats" => ORDERS.fetch(reference) } : nil }
      config.on_paid = ->(settlement) { paid << settlement.reference }
    end
    OpenReceive.config.service
  end

  def env_for(body)
    json = JSON.generate(body)
    {
      "REQUEST_METHOD" => "POST", "PATH_INFO" => "/openreceive/route", "SCRIPT_NAME" => "",
      "QUERY_STRING" => "", "SERVER_NAME" => "example.org", "SERVER_PORT" => "80",
      "rack.url_scheme" => "http", "rack.input" => StringIO.new(json),
      "rack.errors" => StringIO.new, "CONTENT_TYPE" => "application/json",
      "CONTENT_LENGTH" => json.bytesize.to_s
    }
  end

  def dispatch(controller, action, env)
    status, _headers, body = controller.action(action).call(env)
    payload = +""
    body.each { |chunk| payload << chunk }
    [status, JSON.parse(payload)]
  end

  def prepare(reference) = dispatch(OpenReceive::CheckoutsController, :prepare, env_for("reference" => reference))
  def create(reference) = dispatch(OpenReceive::CheckoutsController, :create, env_for("reference" => reference))
  def check(reference, hash) = dispatch(OpenReceive::PaymentsController, :check, env_for("reference" => reference, "payment_hash" => hash))

  def test_a_paid_reference_answers_its_receipt_and_refuses_a_new_attempt
    boot({})
    _status, created = create("order-no-swap")
    hash = created.fetch("checkout").fetch("payment_hash")
    @wallet.settle!(hash, at: Time.now.to_i + 1)
    travel 30.seconds
    # The host closes an order once it is paid: its price hook answers nil.
    OpenReceive.config.amount_for = ->(_reference) {}

    status, prepared = prepare("order-no-swap")
    assert_equal 200, status, prepared
    assert_equal 2_100_000, prepared.fetch("amount_msats")
    assert_equal [], prepared.fetch("payment_methods")
    assert_equal hash, prepared.fetch("paid").fetch("payment_hash")
    assert_equal "lightning", prepared.fetch("paid").fetch("rail")
    assert_equal ["order-no-swap"], @paid

    status, refused = create("order-no-swap")
    assert_equal 409, status, refused
    assert_equal "This reference is already paid.", refused.fetch("message")
    status, refused = dispatch(OpenReceive::SwapsController, :create,
                               env_for("reference" => "order-no-swap", "pay_in_asset" => "USDT_TRON"))
    assert_equal 409, status, refused
    assert_equal 1, @wallet.invoices.length, "nothing new was minted"
  end

  ENVIRONMENTS.each do |label, env|
    tag = label.gsub(/\W+/, "_")

    define_method("test_no_swap_provider_#{tag}_boot_prepare_mint_settle_paid_hook_once") do
      service = boot(env)
      assert_equal [], service.list_swap_options(amount_msats: 2_100_000)

      status, prepared = prepare("order-no-swap")
      assert_equal 200, status, prepared
      assert_equal 2_100_000, prepared.fetch("amount_msats")
      assert_equal [], prepared.fetch("payment_methods")
      assert_empty @wallet.invoices, "prepare mints nothing"

      status, created = create("order-no-swap")
      assert_equal 201, status, created
      checkout = created.fetch("checkout")
      assert_match(/\Alnbc/, checkout.fetch("bolt11"))
      assert_match(/\A[0-9a-f]{64}\z/, checkout.fetch("payment_hash"))
      assert_equal 2_100_000, checkout.fetch("amount_msats")
      assert_equal [], created.fetch("payment_methods")
      assert_equal 1, @wallet.invoices.length

      hash = checkout.fetch("payment_hash")
      status, pending = check("order-no-swap", hash)
      assert_equal 200, status, pending
      assert_equal "pending", pending.fetch("status")
      assert_equal [], pending.fetch("payment_methods")

      @wallet.settle!(hash, at: Time.now.to_i + 1)
      travel 12.seconds
      assert_equal "settled", check("order-no-swap", hash).last.fetch("status")
      travel 12.seconds
      assert_equal "settled", check("order-no-swap", hash).last.fetch("status")
      assert_equal ["order-no-swap"], @paid, "the paid hook fires exactly once"
    end

    define_method("test_no_swap_provider_#{tag}_amounts_past_any_swap_limit_mint_exactly") do
      boot(env)
      { "order-tiny" => 1_000, "order-huge" => 200_000_000_000 }.each do |reference, msats|
        status, created = create(reference)
        assert_equal 201, status, created
        assert_equal msats, created.fetch("checkout").fetch("amount_msats")
        assert_equal [], created.fetch("payment_methods")
      end
    end

    define_method("test_no_swap_provider_#{tag}_swap_routes_refuse_cleanly_and_never_reach_the_wallet") do
      boot(env)
      [[:quote], [:create]].each do |(action)|
        status, body = dispatch(OpenReceive::SwapsController, action, env_for("reference" => "order-no-swap", "pay_in_asset" => "USDT_TRON"))
        assert_equal 503, status, [action, body]
        assert_equal "INTERNAL", body.fetch("code")
        assert_equal "No configured swap provider supports USDT_TRON.", body.fetch("message")
      end
      assert_empty @wallet.invoices, "a refused swap mints no invoice"

      # Status and refund need an attempt to read, so mint one and ask about it.
      _status, created = create("order-no-swap")
      hash = created.fetch("checkout").fetch("payment_hash")
      { status: {}, refund: { "refund_address" => "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb" } }.each do |action, extra|
        status, body = dispatch(OpenReceive::SwapsController, action, env_for({ "reference" => "order-no-swap", "payment_hash" => hash }.merge(extra)))
        assert_equal 404, status, [action, body]
        assert_equal "NOT_FOUND", body.fetch("code")
        assert_equal "The host order has no swap data.", body.fetch("message")
      end
      assert_equal 1, @wallet.invoices.length, "refused swap routes mint nothing"
    end

    define_method("test_no_swap_provider_#{tag}_rates_answer_so_a_checkout_cannot_hang") do
      boot(env)
      get = env_for({}).merge("REQUEST_METHOD" => "GET", "QUERY_STRING" => "currencies=USD", "rack.input" => StringIO.new(""), "CONTENT_LENGTH" => "0")
      status, body = dispatch(OpenReceive::RatesController, :index, get)
      assert_equal 200, status, body
      assert body.fetch("bitcoin").fetch("usd")
    end
  end
end
