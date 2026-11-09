# frozen_string_literal: true

# The Ruby engine's runner for spec/test-vectors/attempt-state-machine.json: one
# operation sequence replayed through the real OpenReceivePayment model and
# OpenReceive.reconcile path over SQLite, comparing the model's prediction after
# every step and checking the state-machine invariants against the engine's own
# rows. attempt_state_machine_test.rb runs the checked-in vectors;
# attempt_state_machine_cli.rb replays a file for `npm run test:model`.

require "active_support/testing/time_helpers"
require "json"
require "openreceive/rails"
require "active_record"

ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ":memory:")
ActiveRecord::Schema.verbose = false
ActiveRecord::Schema.define do
  # Mirrors the install generator's migration template (rails_test.rb does too).
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

class AttemptStateMachineFailure < StandardError
  attr_reader :kind

  def initialize(kind, message)
    super(message)
    @kind = kind
  end
end

# Serves the model's wallet rows as raw NIP-47 shapes and captures one pending
# notification for the engine's subscribe loop.
class AttemptStateMachineWallet
  attr_accessor :notification, :mode

  def initialize(harness)
    @harness = harness
    @mode = "ok"
  end

  def make_invoice(_request)
    raise "not minted"
  end

  def subscribe_notifications
    yield @notification unless @notification.nil?
  end

  def list_transactions(request)
    call_index = @harness.next_wallet_call
    case @mode
    when "fail" then raise "wallet unavailable (model)"
    when "unrecognized_key" then return { "rows" => [] }
    when "unrecognized_type" then return { "transactions" => "nope" }
    when "unusable_rows" then return { "transactions" => [1, 2] }
    end
    if @mode.start_with?("fail_after_") && call_index >= @mode.delete_prefix("fail_after_").to_i
      raise "wallet unavailable (model)"
    end

    low = request["from"] || 0
    high = request["until"]
    rows = @harness.wallet_rows.select do |_id, row|
      row["created_at"] >= low && (high.nil? || row["created_at"] <= high) &&
        (request["unpaid"] || AttemptStateMachineHarness::WALLET_SETTLED.include?(row["state"]))
    end
    ordered = rows.sort_by { |id, row| [-row["created_at"], -id] }
    offset = request["offset"] || 0
    page = ordered.slice(offset, request["limit"]) || []
    { "transactions" => page.map { |id, row| wire_row(id, row) } }
  end

  private

  def wire_row(id, row)
    wire = {
      "type" => "incoming", "payment_hash" => format("%064x", id), "amount" => 1000,
      "created_at" => row["created_at"]
    }
    case row["state"]
    when "settled_at" then wire.merge("settled_at" => row["settled_at"])
    when "settled_full" then wire.merge("state" => "settled", "settled_at" => row["settled_at"])
    when "settled_state" then wire.merge("state" => "settled")
    when "stateless" then wire
    else wire.merge("state" => row["state"])
    end
  end
end

class AttemptStateMachineHarness
  include ActiveSupport::Testing::TimeHelpers

  STATUSES = %w[pending settled expired failed attention].freeze
  CLOSED = %w[expired failed attention].freeze
  GRACE_SECONDS = 900
  WALLET_SETTLED = %w[settled_at settled_state settled_full].freeze
  WALLET_TERMINAL = %w[failed expired].freeze

  attr_accessor :now, :fail_fulfillment, :outcome, :reused_id, :last_reason
  attr_reader :ledger, :wallet_rows, :wallet

  def self.hash_of(id)
    format("%064x", id)
  end

  def initialize
    OpenReceivePayment.delete_all
    OpenReceiveMeta.where.not(key: "schema_version").delete_all
    @now = 0
    @ledger = []
    @wallet_rows = {}
    @wallet_calls = 0
    @fail_fulfillment = false
    rebuild
  end

  def next_wallet_call
    @wallet_calls += 1
    @wallet_calls - 1
  end

  def rebuild
    @wallet = AttemptStateMachineWallet.new(self)
    harness = self
    OpenReceive.reset_config!
    OpenReceive.configure do |config|
      config.authorize = ->(_context) { true }
      config.nwc_client = @wallet
      config.amount_for = ->(_reference) { { "sats" => 1 } }
      config.swap_providers = []
      config.on_paid = lambda do |settlement|
        raise "host rollback (model)" if harness.fail_fulfillment

        harness.ledger << [settlement.reference.to_s, settlement.payment_hash]
      end
    end
  end

  def fulfill_hook
    lambda do |_payment|
      raise "host rollback (model)" if @fail_fulfillment
    end
  end

  def set_wallet_row(id, kind, settled_at, created_at)
    if kind == "absent"
      @wallet_rows.delete(id)
      return
    end
    existing = @wallet_rows[id]
    @wallet_rows[id] = {
      "created_at" => existing ? existing["created_at"] : created_at,
      "state" => kind, "settled_at" => settled_at
    }
  end

  def checkout_for(step)
    {
      "reference" => step["ref"], "payment_hash" => self.class.hash_of(step["id"]),
      "bolt11" => "lnbc-#{step['id']}", "amount_msats" => 1000,
      "created_at" => step["created_at"], "created_at_source" => "wallet",
      "expires_at" => step["expires_at"], "fiat_quote" => nil
    }
  end

  def swap_data_for(step)
    return nil if step["rail"] == "ln"

    {
      "version" => 1,
      "provider_order" => {
        "provider" => "model", "provider_order_id" => "order-#{step['id']}",
        "provider_token" => "model-token", "pay_in_asset" => step["rail"],
        "expires_at" => step["deposit_expires_at"]
      }
    }
  end

  def commit(step)
    OpenReceivePayment.commit_attempt!(
      reference: step["ref"], payment_hash: self.class.hash_of(step["id"]),
      checkout: checkout_for(step), swap_data: swap_data_for(step)
    )
  end

  def apply_step(step)
    @wallet_calls = 0
    @wallet.mode = "ok"
    @fail_fulfillment = step["fail_fulfillment"] == true
    @outcome = nil
    @reused_id = nil
    @last_reason = nil
    travel_to(Time.at(@now).utc)
    case step["op"]
    when "advance" then nil
    when "restart" then rebuild
    when "wallet" then set_wallet_row(step["id"], step["state"], step["settled_at"], step["created_at"])
    when "create" then create(step)
    when "commit"
      begin
        commit(step)
        @outcome = "inserted_or_idempotent"
      rescue OpenReceivePayment::AttemptConflict
        @outcome = "conflict"
      end
    when "scan"
      @wallet.mode = step["mode"]
      @last_reason = OpenReceive.maybe_reconcile!.fetch("reason")
    when "notify" then notify(step)
    when "replay_settlement"
      begin
        OpenReceivePayment.mark_paid_once!(payment_hash: self.class.hash_of(step["id"]), paid_at: step["paid_at"]) do |payment|
          raise "host rollback (model)" if @fail_fulfillment

          @ledger << [payment.reference.to_s, payment.payment_hash]
        end
      rescue RuntimeError
        raise unless @fail_fulfillment
      end
    when "stale_close"
      OpenReceivePayment.record_reconciliation!(
        payment_hash: self.class.hash_of(step["id"]), status: step["status"],
        observed_at: @now, reason: "stale_model"
      )
    else raise "unknown op #{step['op']}"
    end
  end

  def create(step)
    rail = step["rail"]
    action = rail == "ln" ? "checkout.create" : "swap.create"
    begin
      selected = OpenReceivePayment.selected_for(
        reference: step["ref"], action: action,
        pay_in_asset: rail == "ln" ? nil : rail, now: Time.at(@now)
      )
    rescue OpenReceivePayment::AttemptConflict
      @outcome = "already_paid"
      return
    end
    unless selected.nil?
      @outcome = "reused"
      @reused_id = selected.payment_hash.to_i(16)
      return
    end
    commit(step)
    @outcome = "inserted"
  end

  def notify(step)
    if step["kind"] != "sent"
      case step["finality"]
      when "settled_at" then set_wallet_row(step["id"], "settled_full", step["settled_at"], step["created_at"])
      when "state" then set_wallet_row(step["id"], "settled_state", nil, step["created_at"])
      end
    end
    @wallet.notification = notification_payload(step)
    OpenReceive.listen_for_notifications!
    @wallet.notification = nil
  end

  def notification_payload(step)
    type = step["kind"] == "sent" ? "payment_sent" : "payment_received"
    return { "notification_type" => type } if step["finality"] == "absent"

    payload = { "payment_hash" => self.class.hash_of(step["id"]), "amount" => 1000 }
    case step["finality"]
    when "settled_at" then payload = payload.merge("type" => "incoming", "state" => "settled", "settled_at" => step["settled_at"])
    when "state" then payload = payload.merge("type" => "incoming", "state" => "settled")
    when "preimage" then payload = payload.merge("preimage" => "a" * 64)
    end
    { "notification_type" => type, "notification" => payload }
  end

  def read_row(id)
    row = OpenReceivePayment.find_by(payment_hash: self.class.hash_of(id))
    return nil if row.nil?

    {
      "status" => row.status, "reason" => row.status_reason, "paid_at" => row.paid_at&.to_i,
      "reference" => row.reference, "expires_at" => row.expires_at.to_i, "has_swap" => row.swap_data.present?
    }
  end

  def row_counts
    [OpenReceivePayment.count, OpenReceivePayment.distinct.count(:payment_hash)]
  end

  def fail!(kind, message)
    raise AttemptStateMachineFailure.new(kind, message)
  end

  def check_invariants(step, before, after, info)
    after.each do |id, row|
      fail!("invariant", "row #{id} has status #{row['status']}") unless STATUSES.include?(row["status"])
      previous = before[id]
      if previous && previous["status"] == "settled" &&
         (row["status"] != "settled" || row["paid_at"] != previous["paid_at"] || row["reason"] != previous["reason"])
        fail!("invariant", "settled row #{id} overwritten: #{row}")
      end
      if previous && previous["status"] != "pending" && row["status"] != previous["status"]
        fail!("invariant", "closed row #{id} changed status to #{row['status']}")
      end
      next unless previous && previous["status"] == "pending" && CLOSED.include?(row["status"])

      mode = step["mode"].to_s
      ran_scan = step["op"] == "notify" || (step["op"] == "scan" && mode == "ok") || mode.start_with?("fail_after_")
      fail!("invariant", "row #{id} closed without a successful scan") unless ran_scan

      wallet_row = @wallet_rows[id]
      terminal = wallet_row && WALLET_TERMINAL.include?(wallet_row["state"])
      if !terminal && @now < info.fetch(id)["expires_at"] + GRACE_SECONDS
        fail!("invariant", "row #{id} closed before expiry + grace")
      end
    end
    @ledger.group_by(&:first).each do |reference, entries|
      fail!("invariant", "reference #{reference} fulfilled #{entries.length} times") if entries.length > 1
    end
    settled = after.select { |_id, row| row["status"] == "settled" }.group_by { |_id, row| row["reference"] }
    settled.each do |reference, rows|
      entries = @ledger.select { |entry| entry.first == reference }
      fail!("invariant", "reference #{reference} has settled rows but #{entries.length} fulfillments") unless entries.length == 1
      first = rows.select { |_id, row| row["reason"].nil? }
      if first.length != 1 || self.class.hash_of(first.first.first) != entries.first.last
        fail!("invariant", "fulfillment for #{reference} went to the wrong row")
      end
      rows.each do |id, row|
        fail!("invariant", "settled row #{id} has reason #{row['reason']}") unless row["reason"].nil? || row["reason"] == "duplicate_settlement"
      end
    end
    live = {}
    after.each do |id, row|
      next unless row["status"] == "pending" && row["reason"] != "superseded" && row["expires_at"] > @now

      rail = row["has_swap"] ? info.fetch(id)["rail"] : "ln"
      key = "#{row['reference']} #{rail}"
      fail!("invariant", "two live attempts on #{key}: #{live[key]} and #{id}") if live.key?(key)
      live[key] = id
    end
    total, distinct = row_counts
    fail!("invariant", "payment_hash is not unique") if total != distinct
  end

  def replay(sequence)
    expected = {}
    expected_ledger = []
    info = {}
    current = {}
    sequence.fetch("steps").each_with_index do |step, index|
      begin
        @now = step.fetch("t")
        apply_step(step)
        if step.key?("outcome")
          actual = @outcome
          actual = step["outcome"] if step["op"] == "commit" && actual == "inserted_or_idempotent" &&
                                      %w[inserted idempotent].include?(step["outcome"])
          fail!("outcome", "expected #{step['outcome']}, got #{actual}") if actual != step["outcome"]
          if step["outcome"] == "reused" && @reused_id != step["reused_id"]
            fail!("outcome", "reused #{@reused_id}, expected #{step['reused_id']}")
          end
        end
        if step.key?("reason") && @last_reason != step["reason"]
          fail!("outcome", "reason #{@last_reason}, expected #{step['reason']}")
        end
        (step["rows"] || {}).each do |key, row|
          id = key.to_i
          info[id] = { "expires_at" => step["expires_at"], "rail" => step["rail"] } unless expected.key?(id)
          expected[id] = row
        end
        expected_ledger.concat(step["fulfilled"] || [])
        after = {}
        expected.each_key do |id|
          row = read_row(id)
          fail!("state", "row #{id} missing from the engine") if row.nil?
          after[id] = row
        end
        check_invariants(step, current, after, info)
        expected.each do |id, wanted|
          got = after[id]
          if [got["status"], got["reason"], got["paid_at"]] != wanted
            fail!("state", "row #{id}: engine #{got}, model #{wanted}")
          end
        end
        fail!("state", "the engine holds rows the model does not") if row_counts.first != expected.length
        ledger = @ledger.map { |ref, paid| [ref, paid.to_i(16)] }
        fail!("state", "fulfillment ledger #{ledger}, model #{expected_ledger}") if ledger != expected_ledger
        current = after
      rescue AttemptStateMachineFailure => e
        return { "name" => sequence["name"], "ok" => false, "step" => index, "kind" => e.kind, "message" => e.message }
      rescue StandardError => e
        return { "name" => sequence["name"], "ok" => false, "step" => index, "kind" => "error", "message" => "#{e.class}: #{e.message}" }
      end
    end
    { "name" => sequence["name"], "ok" => true }
  ensure
    travel_back
    OpenReceive.reset_config!
  end
end

def run_attempt_state_machine_sequence(sequence)
  AttemptStateMachineHarness.new.replay(sequence)
end
