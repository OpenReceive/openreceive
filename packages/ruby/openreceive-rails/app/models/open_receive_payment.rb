# frozen_string_literal: true

require "digest"
require "time"

# Engine-owned payment attempts. The table lives in the host application's
# database (the install generator emits the migration), but the schema, locking,
# settlement write-once, and reconciliation state machine are library-owned.
#
# An order may have many historical attempts. Each row is direct Lightning or
# exactly one provider swap attempt; never attach several provider orders to one
# invoice. commit_attempt! serializes on an OpenReceive-owned per-reference lock.
# Same-method reusable lives conflict; other rails may remain live
# so payers can switch methods. "Already paid" means any settled row; live means status "pending"
# and unexpired — hosts never see the live/supersede/conflict vocabulary.
class OpenReceivePayment < ActiveRecord::Base
  self.table_name = "openreceive_payments"
  self.filter_attributes += [:swap_data]

  REUSE_BUFFER_SECONDS = 60
  STATUSES = %w[pending settled expired failed attention].freeze

  class AttemptConflict < StandardError; end

  validates :payment_hash,
            presence: true,
            uniqueness: true,
            format: { with: /\A[0-9a-f]{64}\z/ }
  validates :expires_at, presence: true
  validates :status, inclusion: { in: STATUSES }

  # Ties break on payment_hash, matching the JS newest-first ordering so
  # two same-second attempts resolve to the same row in both engines.
  scope :newest_first, -> { order(created_at: :desc, payment_hash: :desc) }
  scope :settled, -> { where(status: "settled") }
  scope :pending, -> { where(status: "pending") }
  # A superseded row stays pending so the wallet scan keeps covering it, but it
  # is no longer offered to a payer — so it neither blocks a new attempt nor is
  # superseded again.
  scope :live_at, lambda { |time|
    pending.where("expires_at > ?", time)
           .where("status_reason IS NULL OR status_reason != ?", "superseded")
  }

  # Namespacing seed for the postgres per-reference advisory lock. Identical to the
  # JS repository's ADVISORY_LOCK_SEED, and the lock key is computed with the
  # same expression, so a database served by both engines at once still
  # serializes one order's commits against each other.
  ADVISORY_LOCK_SEED = 8_210_223
  # MySQL's GET_LOCK names are capped at 64 bytes and an order id is arbitrary
  # host text, so the name is a digest rather than the id itself.
  MYSQL_LOCK_TIMEOUT_SECONDS = 10

  class LockTimeout < StandardError; end

  # The per-reference serialization boundary for commit and settlement, owned
  # entirely by OpenReceive: every predicate commit_attempt! and
  # mark_paid_once! evaluate reads only openreceive_payments rows, so the lock
  # is keyed by the order id alone.
  #
  # Postgres takes a transaction-scoped advisory lock with the same algorithm
  # and seed (8_210_223) as the JS repository's lockReference — the same LOCK,
  # not the same schema: the JS DDL stores unix-seconds BIGINTs and TEXT
  # checkout_data/swap_data where the Rails migration uses datetime columns and
  # t.json, so one table cannot serve both engines. MySQL has no
  # transaction-scoped equivalent, so it takes a session-scoped named lock
  # around the transaction and releases it after commit. SQLite serializes
  # writers itself, so the transaction is the boundary; the payment_hash UNIQUE
  # constraint is the backstop on every adapter.
  def self.with_reference_lock(reference, &block)
    key = reference.to_s
    raise ArgumentError, "reference is required" if key.empty?

    return with_mysql_reference_lock(key, &block) if mysql_connection?

    transaction do
      if postgres_connection?
        connection.select_value(
          sanitize_sql_array(
            ["SELECT pg_advisory_xact_lock(hashtextextended(?, ?))", key, ADVISORY_LOCK_SEED]
          )
        )
      end
      yield
    end
  end

  # GET_LOCK is session-scoped, so it is taken before BEGIN and released after
  # COMMIT — releasing inside the transaction would leave a window where a
  # second worker could commit against state this one has already read.
  def self.with_mysql_reference_lock(key)
    if connection.transaction_open?
      raise RuntimeError, "OpenReceive MySQL reference operations require an outermost transaction; ambient transactions cannot retain the connection-scoped reference lock."
    end

    name = "openreceive:#{Digest::SHA256.hexdigest(key)[0, 40]}"
    acquired = connection.select_value(
      sanitize_sql_array(["SELECT GET_LOCK(?, ?)", name, MYSQL_LOCK_TIMEOUT_SECONDS])
    )
    raise LockTimeout, "Timed out taking the OpenReceive lock for this reference." unless acquired.to_i == 1

    begin
      transaction { yield }
    ensure
      connection.select_value(sanitize_sql_array(["SELECT RELEASE_LOCK(?)", name]))
    end
  end

  def self.postgres_connection?
    connection.adapter_name.to_s.downcase.include?("postg")
  end

  def self.mysql_connection?
    adapter = connection.adapter_name.to_s.downcase
    adapter.include?("mysql") || adapter.include?("trilogy")
  end

  # Never expose provider recovery credentials through ordinary JSON rendering.
  def serializable_hash(options = nil)
    super.except("swap_data")
  end

  def self.selected_for(reference:, action:, payment_hash: nil, pay_in_asset: nil, now: Time.current)
    OpenReceiveMeta.assert_supported_schema!
    attempts = where(reference: reference)
    unless payment_hash.to_s.strip.empty?
      return attempts.find_by(payment_hash: payment_hash.to_s.downcase)
    end

    if %w[checkout.create swap.create].include?(action)
      raise AttemptConflict, "This reference is already paid." if attempts.settled.exists?

      matching = attempts.live_at(now).newest_first.select do |payment|
        matches_create_action?(payment, action, pay_in_asset)
      end
      if matching.length > 1
        raise AttemptConflict, "This reference has multiple unpaid checkouts in progress for this payment method; wait for them to expire before creating another."
      end

      selected = matching.first
      return nil if selected.nil?
      return nil unless reusable?(selected, now)

      return selected
    end

    scope = %w[swap.read swap.refund].include?(action) ? attempts.where.not(swap_data: nil) : attempts
    scope.newest_first.first
  end

  # Called before payer instructions are returned. The order-row lock is the
  # cross-process serialization boundary; no OpenReceive-specific active flag
  # or partial index is needed. Idempotent for a repeated payment_hash.
  # Count attempt rows for one client IP at or after `since` — backs the
  # optional built-in rate limiting (config.rate_limiting).
  # Counts the immutable local-clock stamp, matching the JS repository: neither
  # the wallet-reported created_at nor the moving updated_at may decide a payer's
  # budget window.
  def self.count_attempts_from_ip(client_ip, since)
    where(client_ip: client_ip).where("inserted_at >= ?", since).count
  end

  def self.commit_attempt!(reference:, payment_hash:, checkout:, swap_data: nil, client_ip: nil)
    OpenReceiveMeta.assert_supported_schema!
    normalized_hash = payment_hash.to_s.downcase
    raise ArgumentError, "invalid payment_hash" unless normalized_hash.match?(/\A[0-9a-f]{64}\z/)

    key = reference.to_s
    raise ArgumentError, "reference is required" if key.empty?

    with_reference_lock(key) do
      same = find_by(payment_hash: normalized_hash)
      unless same.nil?
        raise AttemptConflict, "payment hash belongs to another reference" if same.reference.to_s != key
        return same
      end
      raise AttemptConflict, "This reference is already paid." if where(reference: key).settled.exists?

      now = Time.current
      where(reference: key).live_at(now).find_each do |live|
        decision = live_attempt_commit_decision(live, swap_data, now)
        case decision
        when :conflict
          raise AttemptConflict, "An unpaid checkout for this payment method is already in progress for this reference."
        when :supersede
          # Marked, not closed: the invoice stays payable until it expires
          # wallet-side, and closing it here on the local clock would drop it
          # out of the scan set, so funds paid to it could never be matched.
          live.update!(status_reason: "superseded")
        end
      end

      create!(
        reference: key,
        payment_hash: normalized_hash,
        status: "pending",
        expires_at: Time.at(attempt_expires_at(checkout, swap_data)).utc,
        checkout_data: checkout,
        created_at: Time.at(attempt_created_at(checkout)).utc,
        inserted_at: Time.current,
        swap_data: swap_data,
        client_ip: client_ip.presence
      )
    end
  end

  # Write-once settlement. Records every settled attempt, including an
  # accidental second payment: a later sibling settlement is stored with
  # status_reason "duplicate_settlement". The fulfill block runs inside the
  # settlement transaction only for the first settled attempt for a reference, and a
  # settled row is never overwritten.
  #
  # Exactly-once holds across every settlement path OpenReceive owns, because
  # first_for_order is decided from openreceive_payments rows under the same
  # per-reference lock commit_attempt! takes. It says nothing about fulfillment the
  # host triggers elsewhere (an admin action, another processor, a replayed
  # job) — those race each other, and the host guards them. The install
  # generator writes that guidance next to the generated on_paid.
  def self.mark_paid_once!(payment_hash:, paid_at:)
    OpenReceiveMeta.assert_supported_schema!
    payment = find_by(payment_hash: payment_hash.to_s.downcase)
    return nil if payment.nil?

    with_reference_lock(payment.reference) do
      payment.reload
      return payment unless payment.status == "pending"

      first_for_order = !where(reference: payment.reference).settled.exists?
      payment.update!(
        status: "settled",
        status_reason: first_for_order ? nil : "duplicate_settlement",
        paid_at: Time.at(Integer(paid_at)).utc
      )
      yield(payment) if block_given? && first_for_order
      payment
    end
  end

  # Applies a terminal reconciliation transition only while the row is still
  # pending — idempotent, and a settled attempt is never overwritten.
  def self.record_reconciliation!(payment_hash:, status:, observed_at:, reason:)
    OpenReceiveMeta.assert_supported_schema!
    status_text = status.to_s
    unless %w[expired failed attention].include?(status_text)
      raise ArgumentError, "invalid reconciliation status: #{status_text}"
    end

    payment = find_by(payment_hash: payment_hash.to_s.downcase)
    return if payment.nil?

    with_reference_lock(payment.reference) do
      where(payment_hash: payment.payment_hash, status: "pending").update_all(
        status: status_text,
        status_reason: reason,
        updated_at: Time.at(Integer(observed_at)).utc
      )
    end
  end

  # Pending attempts for the reconciler's next wallet scan — oldest first, one
  # batch per pass (OpenReceive::Server::RECONCILE_BATCH_SIZE): the attempts
  # closest to their closure deadline are always covered, and a backlog drains
  # over several passes instead of widening one wallet scan window without
  # bound. Terminal rows never return.
  def self.reconcilable_attempts(after: nil, limit: OpenReceive::Server::RECONCILE_BATCH_SIZE)
    OpenReceiveMeta.assert_supported_schema!
    query = pending.order(created_at: :asc, payment_hash: :asc)
    if after
      created = Time.at(after.fetch("created_at")).utc
      query = query.where("created_at > ? OR (created_at = ? AND payment_hash > ?)", created, created, after.fetch("payment_hash"))
    end
    query.limit([limit, OpenReceive::Server::RECONCILE_BATCH_SIZE].min)
         .pluck(:payment_hash, :created_at, :checkout_data).map do |hash, created_at, checkout|
      {
        "payment_hash" => hash, "created_at" => created_at.to_i,
        "expires_at" => settlement_expires_at(checkout, hash),
        "created_at_source" => checkout["created_at_source"] || checkout[:created_at_source] || "host"
      }
    end
  end

  # Same reconciliation DTO for authenticated by-hash notification lookup.
  def self.find_pending_attempt(payment_hash)
    OpenReceiveMeta.assert_supported_schema!
    row = pending.where(payment_hash: payment_hash.to_s.downcase).pick(:payment_hash, :created_at, :checkout_data)
    return nil if row.nil?

    hash, created_at, checkout = row
    {
      "payment_hash" => hash, "created_at" => created_at.to_i,
      "expires_at" => settlement_expires_at(checkout, hash),
      "created_at_source" => checkout["created_at_source"] || checkout[:created_at_source] || "host"
    }
  end

  # Saved Lightning deadline, independent of the payer's deposit countdown.
  def self.settlement_expires_at(checkout, payment_hash)
    value = checkout[:expires_at] || checkout["expires_at"] || checkout[:expiresAt] || checkout["expiresAt"]
    raise ArgumentError unless value.is_a?(Integer) || (value.is_a?(String) && value.match?(/\A[0-9]+\z/))

    expiry = Integer(value)
    raise ArgumentError if expiry <= 0

    expiry
  rescue TypeError, ArgumentError, NoMethodError
    raise RuntimeError, "Corrupt checkout_data wallet expiry on openreceive payment attempt #{payment_hash}."
  end

  # Host-invoked dry-run report. Normal routes never read terminal repair candidates.
  def self.maintenance_candidates(after: nil, limit: 100)
    OpenReceiveMeta.assert_supported_schema!
    limit = [[limit, 1].max, 1000].min
    query = where(status: %w[attention expired])
    if after
      stamp = Time.iso8601(after.fetch("updated_at"))
      query = query.where("updated_at > ? OR (updated_at = ? AND payment_hash > ?)", stamp, stamp, after.fetch("payment_hash"))
    end
    rows = query.order(:updated_at, :payment_hash).limit(limit).to_a
    cursor = rows.length == limit ? { "updated_at" => rows.last.updated_at.utc.iso8601(6), "payment_hash" => rows.last.payment_hash } : nil
    { "candidates" => rows.filter_map { |row| repair_candidate(row) }, "next_cursor" => cursor, "scanned" => rows.length }
  end

  def self.requeue_reviewed_attempt!(candidate, decision_id:)
    OpenReceiveMeta.assert_supported_schema!
    unless /\A[A-Za-z0-9._:-]{1,120}\z/.match?(decision_id.to_s)
      raise ArgumentError, "decision_id must be a nonsecret operator ticket identifier."
    end
    payment = find_by(payment_hash: candidate.fetch("payment_hash"))
    return false if payment.nil?

    with_reference_lock(payment.reference) do
      payment.reload
      return false unless repair_candidate(payment) == candidate

      audit_key = "repair:#{payment.payment_hash}:#{decision_id}"
      return false if OpenReceiveMeta.exists?(key: audit_key)

      audit = candidate.merge("decision_id" => decision_id, "requeued_at" => Time.now.to_i)
      OpenReceiveMeta.create!(key: audit_key, value: JSON.generate(audit), rev: 0)
      payment.update!(status: "pending", status_reason: "operator_requeued")
      true
    end
  end

  def self.repair_candidate(row)
    return nil unless %w[attention expired].include?(row.status)

    wallet_expiry = settlement_expires_at(row.checkout_data, row.payment_hash)
    reason = row.status == "attention" ? "operator_attention" : nil
    if row.swap_data.present? && %w[not_found_after_expiry no_finality_after_expiry unsettled_after_expiry].include?(row.status_reason) &&
       wallet_expiry > row.expires_at.to_i && row.updated_at.to_i >= row.expires_at.to_i + 900 && row.updated_at.to_i < wallet_expiry + 900
      reason = "early_deposit_deadline_closure"
    end
    return nil if reason.nil?

    { "reference" => row.reference, "payment_hash" => row.payment_hash,
      "status" => row.status, "status_reason" => row.status_reason,
      "updated_at" => row.updated_at.utc.iso8601(6), "instruction_expires_at" => row.expires_at.to_i,
      "wallet_expires_at" => wallet_expiry, "reason" => reason }
  end

  def self.reusable?(payment, now = Time.current)
    payment.expires_at.to_i - now.to_i > REUSE_BUFFER_SECONDS
  end

  def self.matches_create_action?(payment, action, pay_in_asset)
    is_swap = payment.swap_data.present?
    return !is_swap if action == "checkout.create"
    return false unless action == "swap.create"
    return false unless is_swap

    return true if pay_in_asset.blank?

    swap_pay_in_asset(payment.swap_data) == pay_in_asset
  end

  def self.live_attempt_commit_decision(live, incoming_swap_data, now)
    return :ignore unless same_rail_and_asset?(live.swap_data, incoming_swap_data)

    reusable?(live, now) ? :conflict : :supersede
  end

  def self.same_rail_and_asset?(left_swap, right_swap)
    left_present = left_swap.present?
    right_present = right_swap.present?
    return false if left_present != right_present
    return true unless left_present

    left_asset = swap_pay_in_asset(left_swap)
    right_asset = swap_pay_in_asset(right_swap)
    left_asset == right_asset
  end

  # swap_data reaches the model with string or symbol keys depending on the
  # host's JSON column coder, so both are probed. The camelCase `providerOrder`
  # spelling the JS engine writes is NOT: swap and attempt recovery is
  # per-engine (docs/guides/storage.md), because the two schemas cannot serve
  # one table anyway — the JS DDL stores unix-seconds BIGINTs and TEXT
  # checkout_data/swap_data where this engine's migration uses datetime columns
  # and t.json. A half-alias implied a portability that does not work end to end.
  def self.swap_provider_order_value(swap, key)
    swap&.dig("provider_order", key.to_s) || swap&.dig(:provider_order, key.to_sym)
  end

  def self.swap_pay_in_asset(swap)
    swap_provider_order_value(swap, :pay_in_asset)
  end

  def self.attempt_expires_at(checkout, swap_data)
    provider_expiry = swap_provider_order_value(swap_data, :expires_at)
    checkout_expiry =
      checkout[:expires_at] ||
      checkout["expires_at"] ||
      checkout[:expiresAt] ||
      checkout["expiresAt"]
    Integer(provider_expiry || checkout_expiry)
  end

  def self.attempt_created_at(checkout)
    Integer(
      checkout[:created_at] ||
      checkout["created_at"] ||
      checkout[:createdAt] ||
      checkout["createdAt"]
    )
  end

  private_class_method :reusable?, :matches_create_action?, :live_attempt_commit_decision,
                       :same_rail_and_asset?, :swap_provider_order_value, :swap_pay_in_asset,
                       :attempt_expires_at, :attempt_created_at
end
