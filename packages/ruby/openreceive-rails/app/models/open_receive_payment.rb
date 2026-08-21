# frozen_string_literal: true

# Engine-owned payment attempts. The table lives in the host application's
# database (the install generator emits the migration), but the schema, locking,
# settlement write-once, and reconciliation state machine are library-owned.
#
# An order may have many historical attempts. Each row is direct Lightning or
# exactly one provider swap attempt; never attach several provider orders to one
# invoice. commit_attempt! serializes on the host order row. Same-method
# reusable lives conflict; other rails may remain live so payers can switch
# methods. "Already paid" means any settled row; live means status "pending"
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

  # The host order model configured through OpenReceive.config.order_model.
  # Its row is the per-order serialization boundary for commit and settlement.
  def self.order_class
    model = OpenReceive.config.order_model
    model.is_a?(Class) ? model : model.to_s.constantize
  end

  def order
    @order ||= self.class.order_class.find(order_id)
  end

  # Never expose provider recovery credentials through ordinary JSON rendering.
  def serializable_hash(options = nil)
    super.except("swap_data")
  end

  def self.selected_for(order_id:, action:, payment_hash: nil, pay_in_asset: nil, now: Time.current)
    OpenReceiveMeta.assert_supported_schema!
    attempts = where(order_id: order_id)
    unless payment_hash.to_s.strip.empty?
      return attempts.find_by(payment_hash: payment_hash.to_s.downcase)
    end

    if %w[checkout.create swap.create].include?(action)
      raise AttemptConflict, "This order is already paid." if attempts.settled.exists?

      matching = attempts.live_at(now).newest_first.select do |payment|
        matches_create_action?(payment, action, pay_in_asset)
      end
      if matching.length > 1
        raise AttemptConflict,
              "This order has multiple live payment attempts for the same method; reconcile them before creating another."
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

  def self.commit_attempt!(order:, payment_hash:, checkout:, swap_data: nil, client_ip: nil)
    OpenReceiveMeta.assert_supported_schema!
    normalized_hash = payment_hash.to_s.downcase
    raise ArgumentError, "invalid payment_hash" unless normalized_hash.match?(/\A[0-9a-f]{64}\z/)

    order.with_lock do
      same = find_by(payment_hash: normalized_hash)
      unless same.nil?
        raise AttemptConflict, "payment hash belongs to another order" if same.order_id.to_s != order.id.to_s
        return same
      end
      raise AttemptConflict, "This order is already paid." if where(order_id: order.id).settled.exists?

      now = Time.current
      where(order_id: order.id).live_at(now).find_each do |live|
        decision = live_attempt_commit_decision(live, swap_data, now)
        case decision
        when :conflict
          raise AttemptConflict, "This order already has a live payment attempt for the same method."
        when :supersede
          # Marked, not closed: the invoice stays payable until it expires
          # wallet-side, and closing it here on the local clock would drop it
          # out of the scan set, so funds paid to it could never be matched.
          live.update!(status_reason: "superseded")
        end
      end

      create!(
        order_id: order.id,
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
  # settlement transaction only for the order's first settled attempt, and a
  # settled row is never overwritten.
  def self.mark_paid_once!(payment_hash:, paid_at:)
    OpenReceiveMeta.assert_supported_schema!
    payment = find_by(payment_hash: payment_hash.to_s.downcase)
    return nil if payment.nil?

    # Prefer the order-row lock (the commit-side serialization boundary), but
    # a host-deleted order must not stall settlement forever: fall back to
    # locking the payment row itself so the attempt still settles.
    order = begin
      payment.order
    rescue ActiveRecord::RecordNotFound
      nil
    end
    (order || payment).with_lock do
      payment.reload
      return payment if payment.status == "settled"

      first_for_order = !where(order_id: payment.order_id).settled.exists?
      payment.update!(
        status: "settled",
        status_reason: first_for_order ? nil : "duplicate_settlement",
        paid_at: Time.at(Integer(paid_at)).utc
      )
      yield(order, payment) if block_given? && first_for_order
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

    where(payment_hash: payment_hash.to_s.downcase, status: "pending").update_all(
      status: status_text,
      status_reason: reason,
      updated_at: Time.at(Integer(observed_at)).utc
    )
  end

  # Pending attempts for the reconciler's next wallet scan — oldest first, one
  # batch per pass (OpenReceive::Server::RECONCILE_BATCH_SIZE): the attempts
  # closest to their closure deadline are always covered, and a backlog drains
  # over several passes instead of widening one wallet scan window without
  # bound. Terminal rows never return.
  def self.reconcilable_attempts
    OpenReceiveMeta.assert_supported_schema!
    pending.order(created_at: :asc)
           .limit(OpenReceive::Server::RECONCILE_BATCH_SIZE)
           .pluck(:payment_hash, :created_at, :expires_at).map do |hash, created_at, expires_at|
      {
        "payment_hash" => hash,
        "created_at" => created_at.to_i,
        "expires_at" => expires_at.to_i
      }
    end
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

  # swap_data reaches the model with camelCase keys (JS widget flow) or
  # snake_case (Ruby flow), and with string or symbol keys depending on the
  # host's JSON column coder — probe all four spellings once, here.
  def self.swap_provider_order_value(swap, key)
    swap&.dig("providerOrder", key.to_s) ||
      swap&.dig("provider_order", key.to_s) ||
      swap&.dig(:providerOrder, key.to_sym) ||
      swap&.dig(:provider_order, key.to_sym)
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
