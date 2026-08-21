# frozen_string_literal: true

require "minitest/autorun"
require "yaml"
require "erb"
require "json"
require "securerandom"
require "openreceive/rails"
require "active_record"

ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ":memory:")
ActiveRecord::Schema.verbose = false
ActiveRecord::Schema.define do
  create_table :orders, id: :string, force: true do |t|
    t.string :status, null: false, default: "pending_payment"
    t.timestamps
  end

  # Mirrors the install generator's migration template.
  create_table :openreceive_payments, force: true do |t|
    t.string :order_id, null: false
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
  end
  add_index :openreceive_payments, :payment_hash, unique: true
  add_index :openreceive_payments, [:order_id, :created_at]
  add_index :openreceive_payments, [:status, :created_at]
  add_index :openreceive_payments, [:client_ip, :inserted_at]

  # Mirrors the install generator's openreceive_meta table (durable reconcile gate).
  create_table :openreceive_meta, id: false, force: true do |t|
    t.string :key, null: false, primary_key: true
    t.text :value, null: false
    t.bigint :rev, null: false, default: 0
  end
end

class Order < ActiveRecord::Base
  before_create { self.id ||= SecureRandom.uuid }

  def mark_paid!
    update!(status: "paid")
  end
end

require_relative "../app/models/open_receive_payment"
require_relative "../app/models/open_receive_meta"

# Test wallet: mints deterministic invoices and lets tests flip transaction
# states so payments/check and reconciliation observe them.
class FakeWallet
  attr_reader :transactions

  def initialize
    @counter = 0
    @transactions = []
  end

  def make_invoice(request)
    @counter += 1
    hash = @counter.to_s(16).rjust(64, "0")
    now = Time.now.to_i
    @transactions << {
      "type" => "incoming", "payment_hash" => hash, "invoice" => "ln-#{@counter}",
      "amount_msats" => request.fetch("amount_msats"), "transaction_state" => "pending",
      "created_at" => now
    }
    { "invoice" => "ln-#{@counter}", "payment_hash" => hash,
      "amount_msats" => request.fetch("amount_msats"),
      "created_at" => now, "expires_at" => now + request.fetch("expiry", 600) }
  end

  def list_transactions(request)
    rows = @transactions.slice(request.fetch("offset", 0), request.fetch("limit", 20)) || []
    { "transactions" => rows }
  end

  def add_transaction(hash, state:, settled_at: nil)
    row = {
      "type" => "incoming", "payment_hash" => hash, "invoice" => "ln-seeded",
      "amount_msats" => 100_000, "created_at" => Time.now.to_i - 60
    }
    # state: nil seeds a wallet record with no finality signal at all, like a
    # wallet that never sets NIP-47 state fields.
    row["transaction_state"] = state unless state.nil?
    row["settled_at"] = settled_at unless settled_at.nil?
    @transactions << row
  end

  def settle!(hash, at:)
    row = @transactions.find { |transaction| transaction["payment_hash"] == hash }
    row["transaction_state"] = "settled"
    row["settled_at"] = at
  end
end

module OpenReceivePaymentTestHelpers
  def create_order
    Order.create!
  end

  def unique_hash
    SecureRandom.hex(32)
  end

  def build_checkout(order_id:, hash:, created_at: Time.now.to_i, expires_at: Time.now.to_i + 600)
    {
      "order_id" => order_id, "payment_hash" => hash, "bolt11" => "lnbc1",
      "amount_msats" => 100_000, "created_at" => created_at, "expires_at" => expires_at
    }
  end

  def build_swap_data(pay_in_asset: "USDT_TRON", expires_at: Time.now.to_i + 600)
    {
      "version" => 1,
      "provider_order" => {
        "provider" => "test-swap", "provider_order_id" => "swap-1",
        "pay_in_asset" => pay_in_asset, "expires_at" => expires_at
      }
    }
  end

  def commit!(order, hash, expires_at: Time.now.to_i + 600, swap_data: nil)
    OpenReceivePayment.commit_attempt!(
      order: order,
      payment_hash: hash,
      checkout: build_checkout(order_id: order.id, hash: hash, expires_at: expires_at),
      swap_data: swap_data
    )
  end

  def reset_tables!
    OpenReceivePayment.delete_all
    OpenReceiveMeta.delete_all
    Order.delete_all
    OpenReceive.reset_config!
  end
end

class ReconciliationDecisionTableTest < Minitest::Test
  VECTORS = JSON.parse(File.read("spec/test-vectors/attempt-reconciliation.json"))

  def test_grace_matches_shared_vectors
    assert_equal VECTORS.fetch("expiry_grace_seconds"),
                 OpenReceive::Server::Reconciliation::EXPIRY_GRACE_SECONDS
  end

  def test_every_shared_vector
    VECTORS.fetch("vectors").each do |vector|
      actual = OpenReceive::Server::Reconciliation.transition(
        expires_at: vector.dig("attempt", "expires_at"),
        status: vector.fetch("status"),
        observed_at: vector.fetch("observed_at"),
        transaction_state: vector["transaction_state"]
      )
      expected = vector.fetch("expected")
      if expected.nil?
        assert_nil actual, vector.fetch("name")
      else
        assert_equal expected, actual, vector.fetch("name")
      end
    end
  end

  def test_unexpected_status_raises
    assert_raises(ArgumentError) do
      OpenReceive::Server::Reconciliation.transition(expires_at: 0, status: "settled", observed_at: 0)
    end
  end

  def test_post_grace_pending_needs_an_explicit_in_flight_claim_for_attention
    grace = OpenReceive::Server::Reconciliation::EXPIRY_GRACE_SECONDS
    decide = lambda do |transaction_state|
      OpenReceive::Server::Reconciliation.transition(
        expires_at: 2000, status: "pending", observed_at: 2000 + grace,
        transaction_state: transaction_state
      )
    end
    assert_equal({ "status" => "expired", "reason" => "no_finality_after_expiry" }, decide.call(nil))
    assert_equal({ "status" => "attention", "reason" => "unsettled_after_expiry" }, decide.call("pending"))
    assert_equal({ "status" => "attention", "reason" => "unsettled_after_expiry" }, decide.call("accepted"))
  end
end

class OpenReceivePaymentModelTest < Minitest::Test
  include OpenReceivePaymentTestHelpers

  def setup
    reset_tables!
  end

  def test_commit_attempt_is_idempotent_for_a_repeated_hash
    order = create_order
    hash = unique_hash
    first = commit!(order, hash)
    second = commit!(order, hash)
    assert_equal first.id, second.id
    assert_equal 1, OpenReceivePayment.count
    assert_equal "pending", first.reload.status
  end

  def test_commit_attempt_rejects_a_hash_from_another_order
    order = create_order
    hash = unique_hash
    commit!(order, hash)
    assert_raises(OpenReceivePayment::AttemptConflict) { commit!(create_order, hash) }
  end

  def test_commit_attempt_rejects_a_settled_order
    order = create_order
    hash = unique_hash
    commit!(order, hash)
    OpenReceivePayment.mark_paid_once!(payment_hash: hash, paid_at: Time.now.to_i)
    assert_raises(OpenReceivePayment::AttemptConflict) { commit!(order, unique_hash) }
  end

  def test_commit_attempt_rejects_a_reusable_live_same_rail_attempt
    order = create_order
    commit!(order, unique_hash, expires_at: Time.now.to_i + 600)
    assert_raises(OpenReceivePayment::AttemptConflict) { commit!(order, unique_hash) }
  end

  def test_commit_attempt_supersedes_a_near_expiry_same_rail_attempt_without_closing_it
    order = create_order
    stale_hash = unique_hash
    commit!(order, stale_hash, expires_at: Time.now.to_i + 30)
    replacement = commit!(order, unique_hash)

    stale = OpenReceivePayment.find_by(payment_hash: stale_hash)
    # Still payable wallet-side, so it stays pending (and therefore in the scan
    # set); only a wallet scan past expiry plus grace may close it.
    assert_equal "pending", stale.status
    assert_equal "superseded", stale.status_reason
    assert_equal "pending", replacement.status
    assert_equal 2, OpenReceivePayment.count
    assert_includes OpenReceivePayment.reconcilable_attempts.map { |row| row.fetch("payment_hash") },
                    stale_hash
  end

  def test_a_superseded_attempt_is_not_reused_or_superseded_again
    order = create_order
    stale_hash = unique_hash
    commit!(order, stale_hash, expires_at: Time.now.to_i + 30)
    commit!(order, unique_hash)
    # The live replacement is what conflicts; the superseded row must not be
    # what any later decision is made from.
    assert_raises(OpenReceivePayment::AttemptConflict) { commit!(order, unique_hash) }
    stale = OpenReceivePayment.find_by(payment_hash: stale_hash)
    assert_equal "pending", stale.status
    assert_equal "superseded", stale.status_reason
  end

  def test_commit_attempt_leaves_other_rails_live_for_method_switching
    order = create_order
    lightning = commit!(order, unique_hash)
    swap = commit!(order, unique_hash, swap_data: build_swap_data)
    assert_equal %w[pending pending], [lightning.reload.status, swap.reload.status]
  end

  def test_mark_paid_once_settles_and_fulfills_exactly_once
    order = create_order
    hash = unique_hash
    commit!(order, hash)
    fulfilled = []
    paid_at = Time.now.to_i

    OpenReceivePayment.mark_paid_once!(payment_hash: hash, paid_at: paid_at) do |paid_order, payment|
      fulfilled << [paid_order.id, payment.payment_hash]
    end
    OpenReceivePayment.mark_paid_once!(payment_hash: hash, paid_at: paid_at + 99) do |*|
      fulfilled << :replayed
    end

    payment = OpenReceivePayment.find_by(payment_hash: hash)
    assert_equal "settled", payment.status
    assert_nil payment.status_reason
    assert_equal paid_at, payment.paid_at.to_i
    assert_equal [[order.id, hash]], fulfilled
  end

  def test_mark_paid_once_records_a_sibling_duplicate_settlement_without_refulfilling
    order = create_order
    lightning_hash = unique_hash
    swap_hash = unique_hash
    commit!(order, lightning_hash)
    commit!(order, swap_hash, swap_data: build_swap_data)
    fulfilled = []

    OpenReceivePayment.mark_paid_once!(payment_hash: lightning_hash, paid_at: Time.now.to_i) do |*args|
      fulfilled << args
    end
    OpenReceivePayment.mark_paid_once!(payment_hash: swap_hash, paid_at: Time.now.to_i + 5) do |*args|
      fulfilled << args
    end

    duplicate = OpenReceivePayment.find_by(payment_hash: swap_hash)
    assert_equal "settled", duplicate.status
    assert_equal "duplicate_settlement", duplicate.status_reason
    assert_equal 1, fulfilled.length
  end

  def test_record_reconciliation_applies_only_while_pending
    order = create_order
    hash = unique_hash
    commit!(order, hash)
    observed_at = Time.now.to_i

    OpenReceivePayment.record_reconciliation!(
      payment_hash: hash, status: "failed", observed_at: observed_at, reason: "wallet_reported_failed"
    )
    payment = OpenReceivePayment.find_by(payment_hash: hash)
    assert_equal %w[failed wallet_reported_failed], [payment.status, payment.status_reason]
    assert_equal observed_at, payment.updated_at.to_i

    # Idempotent: the row is no longer pending, so a repeat does nothing.
    OpenReceivePayment.record_reconciliation!(
      payment_hash: hash, status: "expired", observed_at: observed_at + 1, reason: "not_found_after_expiry"
    )
    assert_equal "failed", payment.reload.status
  end

  def test_record_reconciliation_never_overwrites_a_settled_attempt
    order = create_order
    hash = unique_hash
    commit!(order, hash)
    paid_at = Time.now.to_i
    OpenReceivePayment.mark_paid_once!(payment_hash: hash, paid_at: paid_at)

    OpenReceivePayment.record_reconciliation!(
      payment_hash: hash, status: "expired", observed_at: paid_at + 9999, reason: "not_found_after_expiry"
    )
    payment = OpenReceivePayment.find_by(payment_hash: hash)
    assert_equal "settled", payment.status
    assert_equal paid_at, payment.paid_at.to_i
  end

  def test_record_reconciliation_accepts_only_terminal_non_settled_statuses
    assert_raises(ArgumentError) do
      OpenReceivePayment.record_reconciliation!(
        payment_hash: unique_hash, status: "settled", observed_at: 0, reason: "nope"
      )
    end
  end

  def test_reconcilable_attempts_returns_pending_rows_only
    order = create_order
    pending_hash = unique_hash
    expires_at = Time.now.to_i + 600
    commit!(order, pending_hash, expires_at: expires_at)
    settled_order = create_order
    settled_hash = unique_hash
    commit!(settled_order, settled_hash)
    OpenReceivePayment.mark_paid_once!(payment_hash: settled_hash, paid_at: Time.now.to_i)

    attempts = OpenReceivePayment.reconcilable_attempts
    assert_equal 1, attempts.length
    attempt = attempts.first
    assert_equal pending_hash, attempt.fetch("payment_hash")
    assert_equal expires_at, attempt.fetch("expires_at")
    assert_kind_of Integer, attempt.fetch("created_at")
  end

  def test_selected_for_raises_already_paid_for_create_actions
    order = create_order
    hash = unique_hash
    commit!(order, hash)
    OpenReceivePayment.mark_paid_once!(payment_hash: hash, paid_at: Time.now.to_i)
    assert_raises(OpenReceivePayment::AttemptConflict) do
      OpenReceivePayment.selected_for(order_id: order.id, action: "checkout.create")
    end
  end

  def test_swap_data_is_filtered_from_serialization_and_inspection
    order = create_order
    payment = commit!(order, unique_hash, swap_data: build_swap_data)
    refute_includes payment.serializable_hash.keys, "swap_data"
    refute_includes JSON.parse(payment.to_json).keys, "swap_data"
    assert_includes OpenReceivePayment.filter_attributes, :swap_data
  end
end

class ConfigurationContractTest < Minitest::Test
  include OpenReceivePaymentTestHelpers

  def setup
    reset_tables!
  end

  def teardown
    OpenReceive.reset_config!
  end

  def test_configuration_has_no_store_or_namespace
    config = OpenReceive::Configuration.new
    refute_respond_to config, :store
    refute_respond_to config, :namespace
    refute_respond_to config, :token_keys
    assert_respond_to config, :load_order
    assert_respond_to config, :amount_for_order
    assert_respond_to config, :allow_spend_capable_wallet
  end

  def test_validate_requires_authorize_plus_simple_trio_or_advanced_hooks
    config = OpenReceive::Configuration.new
    config.nwc_client = FakeWallet.new
    assert_raises(OpenReceive::ConfigurationError) { config.validate! }

    config.authorize = ->(_context) { true }
    assert_raises(OpenReceive::ConfigurationError) { config.validate! }

    config.on_paid = ->(_settlement) {}
    error = assert_raises(OpenReceive::ConfigurationError) { config.validate! }
    assert_match(/load_order and amount_for_order/, error.message)

    config.load_order = ->(order_id) { Order.find_by(id: order_id) }
    config.amount_for_order = ->(_order) { { "sats" => 100 } }
    assert config.validate!
  end

  def test_validate_accepts_the_advanced_hook_surface
    config = OpenReceive::Configuration.new
    config.nwc_client = FakeWallet.new
    config.authorize = ->(_context) { true }
    config.on_paid = ->(_event) {}
    config.resolve_checkout = ->(**_context) { { "amount" => { "sats" => 1 } } }
    error = assert_raises(OpenReceive::ConfigurationError) { config.validate! }
    assert_match(/configured together/, error.message)

    config.on_checkout_created = ->(**_payment) {}
    # Opportunistic reconcile (on by default) scans engine-owned rows, which a
    # custom repository does not have: advanced mode must opt out explicitly
    # rather than have the default settlement path silently degrade.
    error = assert_raises(OpenReceive::ConfigurationError) { config.validate! }
    assert_match(/opportunistic_reconcile/, error.message)

    config.opportunistic_reconcile = false
    assert config.validate!
  end
end

class EngineHostIntegrationTest < Minitest::Test
  include OpenReceivePaymentTestHelpers

  def setup
    reset_tables!
    @wallet = FakeWallet.new
    @fulfilled = []
    fulfilled = @fulfilled
    OpenReceive.configure do |config|
      config.authorize = ->(_context) { true }
      config.nwc_client = @wallet
      config.load_order = ->(order_id) { Order.find_by(id: order_id) }
      config.amount_for_order = ->(_order) { { "sats" => 100 } }
      config.on_paid = ->(settlement) { fulfilled << settlement }
    end
  end

  def teardown
    OpenReceive.reset_config!
  end

  def create_checkout(order_id)
    OpenReceive.config.request_handler.create_checkout(
      raw_body: JSON.generate("order_id" => order_id), request: {}, request_id: "req-test"
    )
  end

  def test_create_commits_a_pending_attempt_and_reuses_it_on_retry
    order = create_order
    first = create_checkout(order.id)
    second = create_checkout(order.id)

    assert_equal 201, first.first
    hash = first.last.dig("checkout", "payment_hash")
    assert_equal hash, second.last.dig("checkout", "payment_hash")
    assert_equal 1, @wallet.transactions.length

    payment = OpenReceivePayment.find_by(payment_hash: hash)
    assert_equal ["pending", order.id], [payment.status, payment.order_id]
  end

  def test_unknown_order_is_not_found
    status, _headers, body = create_checkout("missing-order")
    assert_equal 404, status
    assert_equal "NOT_FOUND", body["code"]
  end

  def test_overlapping_same_method_commit_is_409_not_persist_503
    order = create_order
    assert_equal 201, create_checkout(order.id).first

    loser = build_checkout(order_id: order.id, hash: unique_hash)
    error = assert_raises(OpenReceive::Server::ConflictError) do
      # Concurrent creates both resolve as "mint" before either commits. The
      # loser reaches on_checkout_created with a new hash and must stay a 409,
      # not the handler's infrastructure-failure 503 persist wrap.
      OpenReceive.config.request_handler.send(:commit, loser)
    end
    assert_equal 409, error.status
    assert_equal "CONFLICT", error.code
    assert_match(/live payment attempt/, error.message)
  end

  def test_settlement_fulfills_once_and_blocks_further_creates
    order = create_order
    hash = create_checkout(order.id).last.dig("checkout", "payment_hash")
    @wallet.settle!(hash, at: Time.now.to_i)

    check = lambda do
      OpenReceive.config.request_handler.check_payment(
        raw_body: JSON.generate("order_id" => order.id, "payment_hash" => hash),
        request: {}, request_id: "req-check"
      )
    end
    assert_equal "settled", check.call.last.fetch("status")
    assert_equal "settled", check.call.last.fetch("status")

    assert_equal 1, @fulfilled.length
    settlement = @fulfilled.first
    assert_equal [order.id, hash], [settlement.order_id, settlement.payment_hash]
    assert_equal "settled", OpenReceivePayment.find_by(payment_hash: hash).status

    status, _headers, body = create_checkout(order.id)
    assert_equal 409, status
    assert_equal "CONFLICT", body["code"]
  end

  def test_rate_limiting_counts_rows_stamps_client_ip_and_exempts_reuse
    OpenReceive.config.rate_limiting = { limit_per_hour: 2 }
    OpenReceive.config.reset_runtime!
    request = { "REMOTE_ADDR" => "203.0.113.7" }
    create = lambda do |order_id|
      OpenReceive.config.request_handler.create_checkout(
        raw_body: JSON.generate("order_id" => order_id), request: request, request_id: "req-rl"
      )
    end

    first_order = create_order
    assert_equal 201, create.call(first_order.id).first
    assert_equal 201, create.call(create_order.id).first
    # The extractor's IP is stamped on the committed rows the counter reads.
    assert_equal ["203.0.113.7"], OpenReceivePayment.pluck(:client_ip).uniq

    status, _headers, body = create.call(create_order.id)
    assert_equal 429, status
    assert_equal "RATE_LIMITED", body["code"]
    assert_equal true, body["retryable"]
    # The built-in limiter carries the JS built-in limiter's wording; the
    # generic "Too many requests." belongs to the host-supplied rate_limit hook.
    assert_equal "Too many payment attempts. Please try again later.", body["message"]

    # Reuse of an already-committed attempt is never throttled.
    reuse_status, _reuse_headers, reuse_body = create.call(first_order.id)
    assert_equal 201, reuse_status
    assert reuse_body.dig("checkout", "payment_hash")
  end

  def test_rate_limiting_rejects_a_non_positive_limit
    OpenReceive.config.rate_limiting = { limit_per_hour: 0 }
    OpenReceive.config.reset_runtime!
    # A zero budget would silently block every attributable payer while looking
    # like a configured limit, so it is a configuration error, not a policy.
    error = assert_raises(OpenReceive::ConfigurationError) do
      OpenReceive.config.request_handler
    end
    assert_match(/limit_per_hour must be a positive integer/, error.message)
  end

  def test_rate_limiting_allows_requests_it_cannot_attribute_to_an_ip
    OpenReceive.config.rate_limiting = { limit_per_hour: 1 }
    OpenReceive.config.client_ip = ->(_request) { nil }
    OpenReceive.config.reset_runtime!
    create = lambda do
      OpenReceive.config.request_handler.create_checkout(
        raw_body: JSON.generate("order_id" => create_order.id), request: {}, request_id: "req-anon"
      )
    end
    # Unattributable traffic is not counted (and must not be blocked wholesale).
    assert_equal 201, create.call.first
    assert_equal 201, create.call.first
  ensure
    OpenReceive.config.client_ip = nil
    OpenReceive.config.reset_runtime!
  end

  def test_rate_limiting_buckets_ipv6_clients_by_their_64
    OpenReceive.config.rate_limiting = { limit_per_hour: 1 }
    OpenReceive.config.reset_runtime!
    create = lambda do |order_id, remote_addr|
      OpenReceive.config.request_handler.create_checkout(
        raw_body: JSON.generate("order_id" => order_id),
        request: { "REMOTE_ADDR" => remote_addr }, request_id: "req-v6"
      )
    end

    assert_equal 201, create.call(create_order.id, "2001:db8:1:2:aaaa:bbbb:cccc:dddd").first
    # The stamped client_ip is the JS-identical /64 bucket, so rotating
    # privacy addresses inside one /64 share a single budget.
    assert_equal ["2001:db8:1:2::/64"], OpenReceivePayment.pluck(:client_ip).uniq

    status, _headers, body = create.call(create_order.id, "2001:db8:1:2:1111:2222:3333:4444")
    assert_equal 429, status
    assert_equal "RATE_LIMITED", body["code"]

    # A v4-mapped address collapses to the plain IPv4 bucket.
    assert_equal 201, create.call(create_order.id, "::ffff:203.0.113.7").first
    assert_includes OpenReceivePayment.pluck(:client_ip).uniq, "203.0.113.7"
  end

  def test_settlement_survives_a_host_deleted_order
    order = create_order
    hash = create_checkout(order.id).last.dig("checkout", "payment_hash")
    order.delete

    payment = OpenReceivePayment.mark_paid_once!(payment_hash: hash, paid_at: Time.now.to_i)
    assert_equal "settled", payment.status
  end
end

class ReconcileTest < Minitest::Test
  include OpenReceivePaymentTestHelpers

  def setup
    reset_tables!
    @wallet = FakeWallet.new
    @fulfilled = []
    fulfilled = @fulfilled
    OpenReceive.configure do |config|
      config.authorize = ->(_context) { true }
      config.nwc_client = @wallet
      config.load_order = ->(order_id) { Order.find_by(id: order_id) }
      config.amount_for_order = ->(_order) { { "sats" => 100 } }
      config.on_paid = ->(settlement) { fulfilled << settlement }
    end
  end

  def teardown
    OpenReceive.reset_config!
  end

  def pending_attempt(expires_at:)
    order = create_order
    hash = unique_hash
    commit!(order, hash, expires_at: expires_at)
    [order, hash]
  end

  def test_reconcile_applies_the_shared_decision_table_and_delivers_settlements
    now = Time.now.to_i
    grace = OpenReceive::Server::Reconciliation::EXPIRY_GRACE_SECONDS
    settled_order, settled_hash = pending_attempt(expires_at: now + 600)
    _failed_order, failed_hash = pending_attempt(expires_at: now + 600)
    _live_order, live_hash = pending_attempt(expires_at: now + 600)
    _gone_order, gone_hash = pending_attempt(expires_at: now - grace - 100)
    _stuck_order, stuck_hash = pending_attempt(expires_at: now - grace - 100)
    _stale_order, stale_hash = pending_attempt(expires_at: now - grace - 100)

    @wallet.add_transaction(settled_hash, state: "settled", settled_at: now - 5)
    @wallet.add_transaction(failed_hash, state: "failed")
    @wallet.add_transaction(stuck_hash, state: "pending")
    # A wallet record with no state at all: an ordinary abandoned invoice on a
    # wallet that never sets NIP-47 finality fields.
    @wallet.add_transaction(stale_hash, state: nil)
    # live_hash and gone_hash have no wallet transaction: not_found.

    # reconcile! returns the per-hash check results so callers (payments/check)
    # can serve a requested hash straight from the pass.
    checks = OpenReceive.reconcile!(now: now)
    assert_equal 6, checks.length
    checks_by_hash = checks.to_h { |check| [check.fetch("payment_hash"), check] }
    assert_equal "settled", checks_by_hash.fetch(settled_hash)["status"]
    assert_equal now - 5, checks_by_hash.fetch(settled_hash)["paid_at"]
    assert_equal "not_found", checks_by_hash.fetch(gone_hash)["status"]

    by_hash = ->(hash) { OpenReceivePayment.find_by(payment_hash: hash) }
    settled = by_hash.call(settled_hash)
    assert_equal "settled", settled.status
    assert_equal now - 5, settled.paid_at.to_i
    assert_equal [settled_order.id], @fulfilled.map(&:order_id)

    failed = by_hash.call(failed_hash)
    assert_equal %w[failed wallet_reported_failed], [failed.status, failed.status_reason]

    assert_equal "pending", by_hash.call(live_hash).status

    gone = by_hash.call(gone_hash)
    assert_equal %w[expired not_found_after_expiry], [gone.status, gone.status_reason]

    stuck = by_hash.call(stuck_hash)
    assert_equal %w[attention unsettled_after_expiry], [stuck.status, stuck.status_reason]

    stale = by_hash.call(stale_hash)
    assert_equal %w[expired no_finality_after_expiry], [stale.status, stale.status_reason]

    # A second pass scans only the still-pending attempt and never re-fulfills.
    assert_equal 1, OpenReceive.reconcile!(now: now).length
    assert_equal 1, @fulfilled.length
  end

  def test_a_failed_wallet_scan_closes_nothing
    now = Time.now.to_i
    _order, hash = pending_attempt(expires_at: now - 9_999)
    @wallet.define_singleton_method(:list_transactions) { |_request| raise "relay down" }

    # Wallet failures normalize to the shared error vocabulary but still abort
    # the pass so nothing closes.
    error = assert_raises(OpenReceive::Server::WalletFailureError) { OpenReceive.reconcile!(now: now) }
    assert_equal "relay down", error.message
    assert_equal "OTHER", error.code
    assert_equal "pending", OpenReceivePayment.find_by(payment_hash: hash).status
  end

  def test_reconcile_job_wraps_one_pass
    require "active_job"
    require_relative "../app/jobs/openreceive/reconcile_job"
    ActiveJob::Base.logger = Logger.new(IO::NULL)
    now = Time.now.to_i
    _order, hash = pending_attempt(expires_at: now + 600)
    @wallet.add_transaction(hash, state: "settled", settled_at: now - 1)

    OpenReceive::ReconcileJob.perform_now

    assert_equal "settled", OpenReceivePayment.find_by(payment_hash: hash).status
    assert_equal 1, @fulfilled.length
  end
end

class NotificationsTest < Minitest::Test
  include OpenReceivePaymentTestHelpers

  # FakeWallet plus NWC-02 notification support: captures the subscription,
  # lets tests push notifications through the stored handler, and counts
  # list_transactions calls so tests can prove direct settlement never scans.
  class NotifyingWallet < FakeWallet
    attr_reader :subscribed_types, :list_transactions_calls

    def initialize
      super
      @list_transactions_calls = 0
    end

    def list_transactions(request)
      @list_transactions_calls += 1
      super
    end

    def subscribe_notifications(notification_types = nil, &handler)
      @subscribed_types = notification_types
      @handler = handler
      :subscribed
    end

    def notify(notification)
      @handler.call(notification)
    end
  end

  def setup
    reset_tables!
    @wallet = NotifyingWallet.new
    @fulfilled = []
    fulfilled = @fulfilled
    OpenReceive.configure do |config|
      config.authorize = ->(_context) { true }
      config.nwc_client = @wallet
      config.load_order = ->(order_id) { Order.find_by(id: order_id) }
      config.amount_for_order = ->(_order) { { "sats" => 100 } }
      config.on_paid = ->(settlement) { fulfilled << settlement }
    end
  end

  def teardown
    OpenReceive.reset_config!
  end

  def test_settled_notification_payload_settles_directly_with_zero_wallet_scans
    now = Time.now.to_i
    order = create_order
    hash = unique_hash
    commit!(order, hash, expires_at: now + 600)
    # Deliberately no wallet transaction: only direct settlement can settle.

    assert_equal :subscribed, OpenReceive.listen_for_notifications!
    assert_equal ["payment_received"], @wallet.subscribed_types

    # A payload satisfying the settlement rule settles the pending attempt
    # directly over the authenticated notification channel.
    @wallet.notify(
      "notification_type" => "payment_received",
      "notification" => {
        "type" => "incoming", "payment_hash" => hash, "amount" => 100_000,
        "state" => "settled", "settled_at" => now - 1, "preimage" => "corroborating-only"
      }
    )

    payment = OpenReceivePayment.find_by(payment_hash: hash)
    assert_equal "settled", payment.status
    assert_equal now - 1, payment.paid_at.to_i
    assert_equal [order.id], @fulfilled.map(&:order_id)
    assert_equal 0, @wallet.list_transactions_calls,
                 "direct settlement must not scan the wallet for that invoice"
    assert_empty OpenReceivePayment.reconcilable_attempts
  end

  def test_notification_without_a_finality_signal_falls_back_to_reconcile
    now = Time.now.to_i
    order = create_order
    hash = unique_hash
    commit!(order, hash, expires_at: now + 600)
    @wallet.add_transaction(hash, state: "settled", settled_at: now - 1)

    OpenReceive.listen_for_notifications!

    # A preimage alone is corroborating evidence, never finality; the
    # reconcile! wallet scan is what settles.
    @wallet.notify(
      "notification_type" => "payment_received",
      "notification" => { "payment_hash" => hash, "preimage" => "corroborating-only" }
    )

    payment = OpenReceivePayment.find_by(payment_hash: hash)
    assert_equal "settled", payment.status
    assert_equal [order.id], @fulfilled.map(&:order_id)
    assert_operator @wallet.list_transactions_calls, :>, 0,
                    "a non-final payload must trigger the bounded wallet scan"
  end

  def test_settled_payload_for_an_unknown_hash_only_triggers_a_scan
    now = Time.now.to_i
    order = create_order
    hash = unique_hash
    commit!(order, hash, expires_at: now + 600)

    OpenReceive.listen_for_notifications!
    unknown = unique_hash
    @wallet.notify(
      "notification_type" => "payment_received",
      "notification" => { "payment_hash" => unknown, "state" => "settled", "settled_at" => now }
    )

    assert_equal "pending", OpenReceivePayment.find_by(payment_hash: hash).status
    assert_empty @fulfilled
    assert_operator @wallet.list_transactions_calls, :>, 0
  end

  def test_payment_received_notification_without_a_payload_wakes_reconcile_and_settles
    now = Time.now.to_i
    order = create_order
    hash = unique_hash
    commit!(order, hash, expires_at: now + 600)
    @wallet.add_transaction(hash, state: "settled", settled_at: now - 1)

    OpenReceive.listen_for_notifications!

    # Hash-only notification: a wake-up hint; the reconcile! wallet scan settles.
    @wallet.notify(
      "notification_type" => "payment_received",
      "notification" => { "payment_hash" => hash }
    )

    payment = OpenReceivePayment.find_by(payment_hash: hash)
    assert_equal "settled", payment.status
    assert_equal [order.id], @fulfilled.map(&:order_id)
  end

  def test_other_notification_types_never_wake_reconcile
    now = Time.now.to_i
    order = create_order
    hash = unique_hash
    commit!(order, hash, expires_at: now + 600)
    @wallet.add_transaction(hash, state: "settled", settled_at: now - 1)

    OpenReceive.listen_for_notifications!
    @wallet.notify("notification_type" => "payment_sent", "notification" => {})

    assert_equal "pending", OpenReceivePayment.find_by(payment_hash: hash).status
    assert_empty @fulfilled
  end

  def test_unsupported_client_raises_a_clear_error
    OpenReceive.config.nwc_client = FakeWallet.new
    error = assert_raises(OpenReceive::ConfigurationError) { OpenReceive.listen_for_notifications! }
    assert_match(/does not support NWC-02 notifications/, error.message)
    assert_match(/ReconcileJob/, error.message)
  end
end

# The default Ruby wallet client: OpenReceive builds nwc-ruby from NWC_URI and
# wraps it in OpenReceive::NwcRubyReceiveClient. nwc-ruby's listener is named
# subscribe_to_notifications and yields a value object rather than the NWC-02
# wire hash, so the adapter is what makes push settlement work at all here.
class NwcRubyAdapterNotificationsTest < Minitest::Test
  include OpenReceivePaymentTestHelpers

  # Shaped like NwcRuby::NIP47::Notification: the type, plus the raw NWC-02
  # `notification` object as `data`.
  class NwcRubyNotification
    attr_reader :type, :data

    def initialize(type:, data:)
      @type = type
      @data = data
    end
  end

  # Shaped like NwcRuby::Client: keyword params, and a keyword-only listener
  # that takes a block.
  class NwcRubyStyleWallet
    attr_reader :list_transactions_calls

    def initialize
      @list_transactions_calls = 0
      @handler = nil
    end

    def subscribe_to_notifications(since: Time.now.to_i, kinds: [23_196, 23_197], &block)
      raise ArgumentError, "block required" unless block

      _ = [since, kinds]
      @handler = block
      :subscribed
    end

    def list_transactions(**_params)
      @list_transactions_calls += 1
      { "transactions" => [] }
    end

    def notify(type, payload)
      @handler.call(NwcRubyNotification.new(type: type, data: payload))
    end
  end

  def setup
    reset_tables!
    @wallet = NwcRubyStyleWallet.new
    @fulfilled = []
    fulfilled = @fulfilled
    OpenReceive.configure do |config|
      config.authorize = ->(_context) { true }
      config.nwc_client = OpenReceive::NwcRubyReceiveClient.new(client: @wallet)
      config.load_order = ->(order_id) { Order.find_by(id: order_id) }
      config.amount_for_order = ->(_order) { { "sats" => 100 } }
      config.on_paid = ->(settlement) { fulfilled << settlement }
    end
  end

  def teardown
    OpenReceive.reset_config!
  end

  def test_nwc_ruby_notification_object_settles_directly_with_zero_wallet_scans
    now = Time.now.to_i
    order = create_order
    hash = unique_hash
    commit!(order, hash, expires_at: now + 600)

    assert_equal :subscribed, OpenReceive.listen_for_notifications!

    @wallet.notify(
      "payment_received",
      "type" => "incoming", "state" => "settled", "payment_hash" => hash,
      "amount" => 100_000, "settled_at" => now - 1, "preimage" => "corroborating-only"
    )

    payment = OpenReceivePayment.find_by(payment_hash: hash)
    assert_equal "settled", payment.status
    assert_equal now - 1, payment.paid_at.to_i
    assert_equal [order.id], @fulfilled.map(&:order_id)
    assert_equal 0, @wallet.list_transactions_calls,
                 "direct settlement must not scan the wallet for that invoice"
  end

  def test_payment_sent_never_reaches_the_engine
    now = Time.now.to_i
    order = create_order
    hash = unique_hash
    commit!(order, hash, expires_at: now + 600)

    OpenReceive.listen_for_notifications!
    # Same payment_hash, wrong direction: the adapter filters to the requested
    # type, so this cannot settle and cannot even wake a scan.
    @wallet.notify(
      "payment_sent",
      "type" => "outgoing", "state" => "settled", "payment_hash" => hash, "settled_at" => now
    )

    assert_equal "pending", OpenReceivePayment.find_by(payment_hash: hash).status
    assert_empty @fulfilled
    assert_equal 0, @wallet.list_transactions_calls
  end
end

# The engine's mounted routes are the same contract the OpenAPI document
# describes. Without this, a `get` where the spec says `post` (or a dropped
# route) only surfaces as a 404/405 in someone's app.
class OpenReceiveRailsRouteContractTest < Minitest::Test
  OPENAPI_PATH = File.expand_path("../../../../spec/openapi/openreceive-http.v1.yaml", __dir__)
  ROUTES_PATH = File.expand_path("../config/routes.rb", __dir__)

  # Read the engine's route DSL directly: a bare gem test has no booted Rails
  # app to reflect over, and the DSL file is the thing that must not drift.
  def test_engine_routes_match_the_openapi_contract
    spec = YAML.safe_load(File.read(OPENAPI_PATH))
    expected = spec.fetch("paths").flat_map do |path, operations|
      operations.keys.select { |verb| %w[get post].include?(verb) }
                .map { |verb| [verb.upcase, path.sub(%r{\A/}, "")] }
    end.sort

    actual = File.read(ROUTES_PATH).scan(/^\s*(get|post)\s+"([^"]+)"/).map do |verb, path|
      [verb.upcase, path]
    end.sort

    assert_equal expected, actual,
                 "engine routes drifted from spec/openapi/openreceive-http.v1.yaml"
  end
end

class OpenReceiveRailsGeneratorTemplateTest < Minitest::Test
  TEMPLATE_ROOT = File.expand_path(
    "../lib/generators/openreceive/install/templates",
    __dir__
  )

  TemplateContext = Struct.new(
    :order_model_name,
    :order_table_name,
    :order_primary_key_type,
    :migration_version,
    :add_order_foreign_key?,
    :schema_version,
    :payment_hash_check_sql,
    keyword_init: true
  ) do
    def render(path)
      ERB.new(File.read(path), trim_mode: "-").result(binding)
    end
  end

  def setup
    @context = TemplateContext.new(
      order_model_name: "Order",
      order_table_name: "orders",
      order_primary_key_type: "bigint",
      migration_version: "7.1",
      add_order_foreign_key?: true,
      schema_version: OpenReceive::Server::PAYMENTS_SCHEMA_VERSION,
      payment_hash_check_sql: '"payment_hash ~ \'^[0-9a-f]{64}$\'"'
    )
  end

  def test_payment_model_is_engine_owned_not_generated
    refute File.exist?(File.join(TEMPLATE_ROOT, "payment.rb"))
    model = File.read(File.expand_path("../app/models/open_receive_payment.rb", __dir__))
    assert_includes model, 'self.table_name = "openreceive_payments"'
    assert_includes model, "self.filter_attributes += [:swap_data]"
    assert_includes model, "order.with_lock"
    assert_includes model, 'super.except("swap_data")'
  end

  def test_migration_has_status_columns_and_many_attempts_per_order
    rendered = @context.render(File.join(TEMPLATE_ROOT, "migration.rb"))
    assert_includes rendered, "t.bigint :order_id, null: false"
    assert_includes rendered, 't.string :status, null: false, default: "pending"'
    assert_includes rendered, "t.string :status_reason"
    assert_includes rendered, "add_index :openreceive_payments, :payment_hash, unique: true"
    assert_includes rendered, "add_index :openreceive_payments, [:status, :created_at]"
    assert_includes rendered, "t.json :checkout_data, null: false"
    assert_includes rendered, "t.string :client_ip"
    # The limiter windows on the immutable insert stamp, never the
    # wallet-reported created_at or the moving updated_at.
    assert_includes rendered, "t.datetime :inserted_at, null: false"
    assert_includes rendered, "add_index :openreceive_payments, [:client_ip, :inserted_at]"
    refute_includes rendered, "[:order_id], unique: true"
    assert_includes rendered, "add_foreign_key :openreceive_payments, :orders"
    RubyVM::InstructionSequence.compile(rendered)
  end

  def test_migration_backstops_the_engine_invariants_in_the_database
    rendered = @context.render(File.join(TEMPLATE_ROOT, "migration.rb"))
    assert_includes rendered, "status IN ('pending', 'settled', 'expired', 'failed', 'attention')"
    assert_includes rendered, "openreceive_payments_payment_hash_check"
    assert_includes rendered, "INSERT INTO openreceive_meta (key, value, rev)"
    assert_includes rendered, "'schema_version', '#{OpenReceive::Server::PAYMENTS_SCHEMA_VERSION}'"
    # Liveness is time-dependent (a superseded row stays pending with a future
    # expires_at), so no uniqueness over live attempts may be added here.
    refute_includes rendered, "unique: true, where:"
    RubyVM::InstructionSequence.compile(rendered)
  end

  def test_migration_creates_both_engine_tables_in_one_file
    rendered = @context.render(File.join(TEMPLATE_ROOT, "migration.rb"))
    assert_includes rendered, "class CreateOpenreceiveTables < ActiveRecord::Migration[7.1]"
    assert_includes rendered, "create_table :openreceive_payments"
    assert_includes rendered, "create_table :openreceive_meta, id: false"
    assert_includes rendered, "t.string :key, null: false, primary_key: true"
    assert_includes rendered, "t.bigint :rev, null: false, default: 0"
  end

  def test_initializer_uses_the_simple_host_contract_and_mentions_reconciliation
    rendered = @context.render(File.join(TEMPLATE_ROOT, "initializer.rb"))
    assert_includes rendered, "config.authorize"
    assert_includes rendered, "config.load_order = ->(order_id) { Order.find_by(id: order_id) }"
    assert_includes rendered, "config.amount_for_order"
    assert_includes rendered, "config.on_paid"
    assert_includes rendered, "OpenReceive::ReconcileJob"
    assert_includes rendered, "openreceive:reconcile"
    refute_includes rendered, "resolve_checkout"
    refute_includes rendered, "on_checkout_created"
    refute_match(/after_initialize\s+do/, rendered)
    assert_includes rendered, 'config.parent_controller = "ApplicationController"'
    RubyVM::InstructionSequence.compile(rendered)
  end

  def test_engine_application_controller_skips_forgery_protection
    source = File.read(
      File.expand_path("../app/controllers/openreceive/application_controller.rb", __dir__)
    )
    assert_includes source, "skip_forgery_protection"
    assert_includes source, "eager-loads this class before after_initialize"
  end

  def test_generator_exposes_order_key_and_skip_options_without_a_model_step
    source = File.read(
      File.expand_path(
        "../lib/generators/openreceive/install/install_generator.rb",
        __dir__
      )
    )
    assert_includes source, "migration_template"
    assert_includes source, "order_primary_key_type"
    assert_includes source, "skip_migration"
    assert_includes source, "skip_foreign_key"
    assert_includes source, "db/migrate/create_openreceive_tables.rb"
    refute_includes source, "skip_payment_model"
    refute_includes source, "payment.rb"
  end
end

class OpportunisticReconcileTest < Minitest::Test
  include OpenReceivePaymentTestHelpers

  def setup
    reset_tables!
    @wallet = FakeWallet.new
    @fulfilled = []
    fulfilled = @fulfilled
    OpenReceive.configure do |config|
      config.authorize = ->(_context) { true }
      config.nwc_client = @wallet
      config.load_order = ->(order_id) { Order.find_by(id: order_id) }
      config.amount_for_order = ->(_order) { { "sats" => 100 } }
      config.on_paid = ->(settlement) { fulfilled << settlement }
    end
  end

  def teardown
    OpenReceive.reset_config!
  end

  def pending_attempt(expires_at:)
    order = create_order
    hash = unique_hash
    commit!(order, hash, expires_at: expires_at)
    [order, hash]
  end

  def count_wallet_scans!
    scans = { count: 0 }
    original = @wallet.method(:list_transactions)
    @wallet.define_singleton_method(:list_transactions) do |request|
      scans[:count] += 1
      original.call(request)
    end
    scans
  end

  def test_gate_two_workers_share_one_scan_per_interval
    now = Time.now.to_i
    assert OpenReceiveMeta.claim_reconcile_gate(now: now, interval_seconds: 2)
    # A second Puma worker at the same instant loses (gate_busy) — every worker
    # shares the one durable openreceive_meta row.
    refute OpenReceiveMeta.claim_reconcile_gate(now: now, interval_seconds: 2)
    refute OpenReceiveMeta.claim_reconcile_gate(now: now + 1, interval_seconds: 2)
    assert OpenReceiveMeta.claim_reconcile_gate(now: now + 2, interval_seconds: 2)
  end

  def test_maybe_reconcile_skips_without_pending_and_without_a_wallet_call
    scans = count_wallet_scans!
    assert_equal({ "reason" => "no_pending" }, OpenReceive.maybe_reconcile!)
    assert_equal 0, scans[:count]
  end

  def test_maybe_reconcile_runs_one_gated_pass_then_gate_busy
    now = Time.now.to_i
    _order, hash = pending_attempt(expires_at: now + 600)
    @wallet.add_transaction(hash, state: "settled", settled_at: now - 5)
    scans = count_wallet_scans!

    result = OpenReceive.maybe_reconcile!(now: now)
    assert_equal "ran", result.fetch("reason")
    checked = result.fetch("checks").find { |check| check["payment_hash"] == hash }
    assert_equal ["settled", now - 5], [checked["status"], checked["paid_at"]]
    assert_equal 1, @fulfilled.length
    scans_after_pass = scans[:count]
    assert scans_after_pass >= 1

    # A rapid second call inside the 2s interval never touches the wallet.
    _other_order, _other_hash = pending_attempt(expires_at: now + 600)
    assert_equal({ "reason" => "gate_busy" }, OpenReceive.maybe_reconcile!(now: now))
    assert_equal scans_after_pass, scans[:count]
  end

  def test_maybe_reconcile_never_raises_and_leaves_the_gate_claimed
    now = Time.now.to_i
    pending_attempt(expires_at: now + 600)
    @wallet.define_singleton_method(:list_transactions) { |_request| raise "relay down" }

    quiet do
      assert_equal({ "reason" => "scan_failed" }, OpenReceive.maybe_reconcile!(now: now))
    end
    # claimed_at stays: a broken wallet cannot stampede scans.
    refute OpenReceiveMeta.claim_reconcile_gate(now: now, interval_seconds: 2)
  end

  def test_maybe_reconcile_disabled_by_configuration
    OpenReceive.config.opportunistic_reconcile = false
    pending_attempt(expires_at: Time.now.to_i + 600)
    scans = count_wallet_scans!
    assert_equal({ "reason" => "disabled" }, OpenReceive.maybe_reconcile!)
    assert_equal 0, scans[:count]
  end

  def test_check_payment_serves_the_requested_hash_from_the_pass
    now = Time.now.to_i
    order, hash = pending_attempt(expires_at: now + 600)
    @wallet.add_transaction(hash, state: "settled", settled_at: now - 5)
    reconcile_pass = OpenReceive.maybe_reconcile!(now: now)
    assert_equal "ran", reconcile_pass.fetch("reason")

    scans = count_wallet_scans!
    status, _headers, body = OpenReceive.config.request_handler.check_payment(
      raw_body: JSON.generate("order_id" => order.id, "payment_hash" => hash),
      request: {}, request_id: "req-pass",
      reconcile_pass: reconcile_pass,
      attempt_status: ->(_hash) { flunk "the pass winner must not fall back to the row" }
    )
    assert_equal 200, status
    assert_equal "settled", body.fetch("status")
    assert_equal now - 5, body.fetch("paid_at")
    refute_nil body["details"], "the gate winner serves details from the pass"
    # The route consumed the dispatch-level pass: no extra per-invoice wallet walk.
    assert_equal 0, scans[:count]
  end

  def test_check_payment_gate_busy_serves_the_row_and_attention_reads_pending
    now = Time.now.to_i
    order, hash = pending_attempt(expires_at: now + 600)
    OpenReceivePayment.find_by(payment_hash: hash).update!(status: "attention")
    attempt_status = lambda do |requested|
      payment = OpenReceivePayment.find_by(payment_hash: requested.to_s.downcase)
      next nil if payment.nil?

      { "status" => payment.status, "paid_at" => payment.paid_at&.to_i }.compact
    end

    scans = count_wallet_scans!
    status, _headers, body = OpenReceive.config.request_handler.check_payment(
      raw_body: JSON.generate("order_id" => order.id, "payment_hash" => hash),
      request: {}, request_id: "req-busy",
      reconcile_pass: { "reason" => "gate_busy" },
      attempt_status: attempt_status
    )
    assert_equal 200, status
    # Row `attention` is operator state, not payer information.
    assert_equal "pending", body.fetch("status")
    assert_nil body["details"]
    assert_nil body["paid_at"]
    assert_equal 0, scans[:count]

    OpenReceivePayment.find_by(payment_hash: hash).update!(status: "settled", paid_at: Time.at(now - 5).utc)
    _status, _headers, settled_body = OpenReceive.config.request_handler.check_payment(
      raw_body: JSON.generate("order_id" => order.id, "payment_hash" => hash),
      request: {}, request_id: "req-busy-settled",
      reconcile_pass: { "reason" => "gate_busy" },
      attempt_status: attempt_status
    )
    assert_equal ["settled", now - 5], [settled_body.fetch("status"), settled_body.fetch("paid_at")]
    assert_nil settled_body["details"]
    assert_equal 0, scans[:count]
  end

  private

  # Silence the maybe_reconcile! warning without hiding real test output.
  def quiet
    original = $stderr
    $stderr = StringIO.new
    yield
  ensure
    $stderr = original
  end
end
