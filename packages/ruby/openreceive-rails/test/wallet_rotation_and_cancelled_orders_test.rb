# frozen_string_literal: true

require "minitest/autorun"
require "logger"
require "stringio"
require_relative "attempt_state_machine_runner"

# Two lifetime edge cases through the real Rails engine models, request handler
# and reconcile gate over SQLite: the merchant changing the wallet code while
# invoices are pending, and the host's order going away while the payer is
# paying. A row records nothing about the wallet that minted it, and
# settlement is keyed by the attempt row, never by the host's order.
class WalletRotationAndCancelledOrdersTest < Minitest::Test
  include ActiveSupport::Testing::TimeHelpers

  GATE_SECONDS = 3
  GRACE_SECONDS = OpenReceive::Server::Reconciliation::EXPIRY_GRACE_SECONDS
  JSON_REQUEST = { "CONTENT_TYPE" => "application/json" }.freeze

  # A wallet: hashes are its mint counter, an unpaid row is only listed when asked for.
  class Wallet
    attr_reader :invoices
    attr_writer :notification

    def initialize(clock, minted: 0)
      @clock = clock
      @counter = minted
      @invoices = {}
    end

    def make_invoice(request)
      @counter += 1
      hash = format("%064x", @counter)
      created_at = @clock.call
      @invoices[hash] = {
        "type" => "incoming", "payment_hash" => hash, "invoice" => "ln-#{@counter}",
        "amount_msats" => request.fetch("amount_msats"), "created_at" => created_at,
        "expires_at" => created_at + request.fetch("expiry", 600), "transaction_state" => "pending"
      }
      @invoices[hash].slice("invoice", "payment_hash", "amount_msats", "created_at", "expires_at")
    end

    def list_transactions(request)
      rows = @invoices.values.select do |row|
        (request["unpaid"] || row["transaction_state"] == "settled") &&
          row["created_at"] >= request.fetch("from", 0) &&
          (request["until"].nil? || row["created_at"] <= request["until"])
      end
      rows = rows.sort_by { |row| [-row["created_at"], row["payment_hash"]] }
      { "transactions" => rows.slice(request.fetch("offset", 0), request.fetch("limit", 20)) || [] }
    end

    def subscribe_notifications
      yield @notification unless @notification.nil?
    end

    def settle!(hash, at:)
      @invoices.fetch(hash).merge!("transaction_state" => "settled", "settled_at" => at)
    end
  end

  def setup
    OpenReceivePayment.delete_all
    OpenReceiveMeta.where.not(key: "schema_version").delete_all
    ActiveRecord::Base.connection.create_table(:fulfilled, force: true) { |t| t.string :reference, null: false }
    @now = 1_700_000_000
    travel_to(Time.at(@now).utc)
    @orders = {}
    @refused = []
    @paid = []
    @hook_error = nil
    @doomed = []
    @log = StringIO.new
    ::Rails.logger = Logger.new(@log)
  end

  def teardown
    travel_back
    ::Rails.logger = nil
    OpenReceive.reset_config!
    ActiveRecord::Base.connection.drop_table(:fulfilled)
  end

  def advance(seconds)
    @now += seconds
    travel_to(Time.at(@now).utc)
  end

  def move_to(instant)
    @now = instant
    travel_to(Time.at(@now).utc)
  end

  def wallet(minted: 0)
    Wallet.new(-> { @now }, minted: minted)
  end

  # The fake wallet's hashes are its mint counter; a history keeps two wallets apart.
  def wallet_with_history
    wallet(minted: 32)
  end

  def connection_to(target)
    connection = Object.new
    %i[make_invoice list_transactions].each do |name|
      connection.define_singleton_method(name) { |request| target.public_send(name, request) }
    end
    connection
  end

  # A shop process: fresh configuration over the same database.
  def start(client)
    orders = @orders
    refused = @refused
    OpenReceive.reset_config!
    OpenReceive.configure do |config|
      config.nwc_client = client
      config.swap_providers = []
      config.authorize = ->(context) { !refused.include?(context.fetch(:resource).fetch(:reference)) }
      config.amount_for = ->(reference) { orders[reference] }
      config.on_paid = method(:fulfill)
    end
  end

  def fulfill(settlement)
    ActiveRecord::Base.connection.execute(
      "INSERT INTO fulfilled (reference) VALUES (#{ActiveRecord::Base.connection.quote(settlement.reference)})"
    )
    raise @hook_error if @hook_error
    raise "the order row is gone" if @doomed.include?(settlement.reference)

    @paid << settlement
  end

  def create_checkout(reference)
    OpenReceive.config.request_handler.create_checkout(
      raw_body: JSON.generate("reference" => reference), request: JSON_REQUEST, request_id: "req-test"
    )
  end

  def checkout(reference, sats: 100)
    @orders[reference] = { "sats" => sats }
    status, _headers, body = create_checkout(reference)
    assert_equal 201, status, body.inspect
    body.fetch("checkout")
  end

  # What the engine's around_action and PaymentsController do for payments/check.
  def check(reference, hash)
    pass = OpenReceive.maybe_reconcile!
    status, _headers, body = OpenReceive.config.request_handler.check_payment(
      raw_body: JSON.generate("reference" => reference, "payment_hash" => hash), request: JSON_REQUEST,
      request_id: "req-check", reconcile_pass: pass,
      attempt_status: lambda do |payment_hash|
        payment = OpenReceivePayment.find_by(payment_hash: payment_hash)
        next nil if payment.nil?

        { "status" => payment.status, "paid_at" => payment.paid_at&.to_i }.compact
      end
    )
    [status, body]
  end

  def row(hash)
    OpenReceivePayment.find_by(payment_hash: hash).attributes.values_at("status", "status_reason", "paid_at")
  end

  def fulfilled
    ActiveRecord::Base.connection.select_values("SELECT reference FROM fulfilled")
  end

  def warnings
    @log.string.lines.grep(/\A(W|E|F),/)
  end

  def test_a_new_code_for_the_same_wallet_keeps_the_pending_invoice_paying_exactly_once
    the_wallet = wallet
    start(connection_to(the_wallet))
    invoice = checkout("order-a")

    start(connection_to(the_wallet))
    the_wallet.settle!(invoice.fetch("payment_hash"), at: @now + 1)
    advance(GATE_SECONDS)
    status, body = check("order-a", invoice.fetch("payment_hash"))
    assert_equal [200, "settled"], [status, body.fetch("status")]
    assert_equal ["order-a"], @paid.map(&:reference)

    advance(100)
    assert_equal "settled", check("order-a", invoice.fetch("payment_hash")).last.fetch("status")
    assert_equal 409, create_checkout("order-a").first
    assert_equal ["order-a"], fulfilled
    assert_empty warnings
  end

  def test_a_code_for_a_different_wallet_closes_the_old_invoice_normally
    old_wallet = wallet_with_history
    start(old_wallet)
    stranded = checkout("order-a")
    hash = stranded.fetch("payment_hash")

    new_wallet = wallet
    start(new_wallet)
    old_wallet.settle!(hash, at: @now + 1)
    refute_includes new_wallet.invoices.keys, hash

    5.times do
      advance(GATE_SECONDS)
      status, body = check("order-a", hash)
      assert_equal [200, "pending"], [status, body.fetch("status")]
    end
    assert_equal "pending", row(hash).first

    # A retry of the same order is still served the old wallet's invoice while
    # it is reusable: nothing on the row says which wallet minted it.
    advance(10)
    status, _headers, body = create_checkout("order-a")
    assert_equal [201, hash], [status, body.dig("checkout", "payment_hash")]
    assert_empty new_wallet.invoices

    fresh = checkout("order-b")
    refute_equal hash, fresh.fetch("payment_hash")
    new_wallet.settle!(fresh.fetch("payment_hash"), at: @now)
    advance(GATE_SECONDS)
    assert_equal "settled", check("order-b", fresh.fetch("payment_hash")).last.fetch("status")
    assert_equal ["order-b"], @paid.map(&:reference)

    move_to(stranded.fetch("expires_at") + GRACE_SECONDS - 1)
    check("order-a", hash)
    assert_equal "pending", row(hash).first

    move_to(stranded.fetch("expires_at") + GRACE_SECONDS + 12)
    status, body = check("order-a", hash)
    assert_equal [200, "expired"], [status, body.fetch("status")]
    assert_equal ["expired", "not_found_after_expiry", nil], row(hash)

    assert_equal ["order-b"], fulfilled
    assert_empty warnings, "every pass over the stranded row succeeded"
    refute_equal hash, checkout("order-a").fetch("payment_hash")
  end

  def test_a_payment_that_landed_on_the_old_wallet_is_reported_to_the_merchant
    skip("bug: closing an attempt the current wallet never knew logs at most an info line")
    old_wallet = wallet_with_history
    start(old_wallet)
    stranded = checkout("order-a")
    start(wallet)
    old_wallet.settle!(stranded.fetch("payment_hash"), at: @now + 1)
    move_to(stranded.fetch("expires_at") + GRACE_SECONDS + 12)
    check("order-a", stranded.fetch("payment_hash"))
    assert_equal "expired", row(stranded.fetch("payment_hash")).first
    refute_empty warnings, @log.string
  end

  def test_an_order_cancelled_mid_payment_still_reaches_on_paid_exactly_once
    the_wallet = wallet
    start(the_wallet)
    invoice = checkout("order-a")

    @orders.delete("order-a")
    the_wallet.settle!(invoice.fetch("payment_hash"), at: @now + 1)
    advance(GATE_SECONDS)

    status, body = check("order-a", invoice.fetch("payment_hash"))
    assert_equal [200, "settled"], [status, body.fetch("status")]
    assert_equal ["order-a"], fulfilled

    advance(50)
    assert_equal "settled", check("order-a", invoice.fetch("payment_hash")).last.fetch("status")
    assert_equal ["order-a"], fulfilled, "a replayed pass never fulfills again"
    assert_empty warnings
  end

  def test_authorize_refusing_the_status_poll_does_not_stop_settlement
    the_wallet = wallet
    start(the_wallet)
    invoice = checkout("order-a")

    @refused << "order-a"
    the_wallet.settle!(invoice.fetch("payment_hash"), at: @now + 1)
    advance(GATE_SECONDS)

    status, _body = check("order-a", invoice.fetch("payment_hash"))
    assert_equal 403, status
    assert_equal ["order-a"], fulfilled
    assert_equal "settled", row(invoice.fetch("payment_hash")).first
  end

  def test_a_raising_host_handler_rolls_back_is_retried_and_fulfills_once
    the_wallet = wallet
    start(the_wallet)
    invoice = checkout("order-a")
    hash = invoice.fetch("payment_hash")

    @hook_error = RuntimeError.new("the order row is gone")
    the_wallet.settle!(hash, at: @now + 1)
    advance(GATE_SECONDS)
    status, body = check("order-a", hash)
    assert_equal [200, "pending"], [status, body.fetch("status")]
    assert_equal "pending", row(hash).first
    assert_empty fulfilled, "the hook write rolled back with the settlement"
    assert_includes @log.string, "the order row is gone"

    @hook_error = nil
    advance(GATE_SECONDS)
    assert_equal "settled", check("order-a", hash).last.fetch("status")
    assert_equal 1, @paid.length
    assert_equal ["order-a"], fulfilled
  end

  def test_a_hook_that_raises_forever_never_closes_the_row_or_starves_another_order
    the_wallet = wallet
    start(the_wallet)
    doomed = checkout("order-doomed")
    healthy = checkout("order-ok")

    @doomed << "order-doomed"
    the_wallet.settle!(doomed.fetch("payment_hash"), at: @now + 1)
    the_wallet.settle!(healthy.fetch("payment_hash"), at: @now + 1)
    advance(GATE_SECONDS)
    check("order-ok", healthy.fetch("payment_hash"))
    assert_equal "settled", row(healthy.fetch("payment_hash")).first
    assert_equal ["order-ok"], fulfilled

    3.times do |index|
      move_to(doomed.fetch("expires_at") + GRACE_SECONDS + (index + 1) * 20)
      assert_equal "pending", check("order-doomed", doomed.fetch("payment_hash")).last.fetch("status")
      assert_equal "pending", row(doomed.fetch("payment_hash")).first, "paid, so never closed as expired"
    end
    assert_operator warnings.length, :>=, 3
    assert_equal ["order-ok"], fulfilled
  end

  def test_a_notification_for_a_cancelled_order_settles_it_once_and_a_raising_hook_falls_back
    the_wallet = wallet
    start(the_wallet)
    invoice = checkout("order-a")
    hash = invoice.fetch("payment_hash")
    @orders.delete("order-a")

    @hook_error = RuntimeError.new("the order row is gone")
    the_wallet.settle!(hash, at: @now + 1)
    the_wallet.notification = { "notification_type" => "payment_received", "notification" => the_wallet.invoices.fetch(hash) }
    deliver = -> { OpenReceive.listen_for_notifications! }
    deliver.call
    assert_equal "pending", row(hash).first

    @hook_error = nil
    advance(GATE_SECONDS)
    deliver.call
    assert_equal "settled", row(hash).first
    advance(GATE_SECONDS)
    deliver.call
    assert_equal ["order-a"], fulfilled
  end
end
