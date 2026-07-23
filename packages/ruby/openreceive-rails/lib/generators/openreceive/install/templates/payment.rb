# frozen_string_literal: true

# Host-owned payment attempts created through OpenReceive. An order may have
# many historical attempts. Each row is direct Lightning or exactly one
# provider swap attempt; never attach several provider orders to one invoice.
# commit_attempt! serializes on the order row so only one still-payable attempt
# can be returned to a payer.
class OpenReceivePayment < ApplicationRecord
  self.table_name = "openreceive_payments"
  self.filter_attributes += [:swap_data]

  class AttemptConflict < StandardError; end

  belongs_to :order, class_name: "<%= order_model_name %>", inverse_of: false

  validates :payment_hash,
            presence: true,
            uniqueness: true,
            format: { with: /\A[0-9a-f]{64}\z/ }
  validates :expires_at, presence: true

  scope :newest_first, -> { order(created_at: :desc, id: :desc) }
  scope :unpaid, -> { where(paid_at: nil) }
  scope :live_at, ->(time) { unpaid.where("expires_at > ?", time) }

  # Never expose provider recovery credentials through ordinary JSON rendering.
  def serializable_hash(options = nil)
    super.except("swap_data")
  end

  def self.selected_for(order_id:, action:, payment_hash: nil, now: Time.current)
    attempts = where(order_id: order_id)
    return attempts.find_by(payment_hash: payment_hash.downcase) if payment_hash.present?

    if %w[checkout.create swap.create].include?(action)
      paid = attempts.where.not(paid_at: nil).newest_first.first
      return paid unless paid.nil? # The handler will refuse to recover a settled invoice.

      live = attempts.live_at(now).newest_first.limit(2).to_a
      raise AttemptConflict, "order has multiple live OpenReceive payments" if live.length > 1

      return live.first
    end

    scope = %w[swap.read swap.refund].include?(action) ? attempts.where.not(swap_data: nil) : attempts
    scope.newest_first.first
  end

  # Called before payer instructions are returned. The order-row lock is the
  # cross-process serialization boundary; no OpenReceive-specific active flag
  # or partial index is needed.
  def self.commit_attempt!(order:, payment_hash:, checkout:, swap_data: nil)
    normalized_hash = payment_hash.to_s.downcase
    raise ArgumentError, "invalid payment_hash" unless normalized_hash.match?(/\A[0-9a-f]{64}\z/)

    order.with_lock do
      same = find_by(payment_hash: normalized_hash)
      unless same.nil?
        raise AttemptConflict, "payment hash belongs to another order" if same.order_id != order.id
        return same
      end
      raise AttemptConflict, "order is already paid" if where(order_id: order.id).where.not(paid_at: nil).exists?

      live = where(order_id: order.id).live_at(Time.current).newest_first.first
      raise AttemptConflict, "order already has a live payment attempt" unless live.nil?

      create!(
        order: order,
        payment_hash: normalized_hash,
        expires_at: Time.at(attempt_expires_at(checkout, swap_data)).utc,
        swap_data: swap_data
      )
    end
  end

  # Records every settled attempt, including an accidental second payment.
  # `first_for_order` is true exactly once under the order lock; couple host
  # fulfillment to that branch in the same transaction.
  def self.mark_paid_once!(payment_hash:, paid_at:)
    payment = find_by!(payment_hash: payment_hash.to_s.downcase)
    payment.order.with_lock do
      payment.reload
      return payment unless payment.paid_at.nil?

      first_for_order = !where(order_id: payment.order_id).where.not(paid_at: nil).exists?
      payment.update!(paid_at: Time.at(Integer(paid_at)).utc)
      yield(payment.order, payment, first_for_order) if block_given?
      payment
    end
  end

  def self.attempt_expires_at(checkout, swap_data)
    provider_expiry =
      swap_data&.dig(:providerOrder, :expires_at) ||
      swap_data&.dig("providerOrder", "expires_at") ||
      swap_data&.dig(:provider_order, :expires_at) ||
      swap_data&.dig("provider_order", "expires_at")
    checkout_expiry =
      checkout[:expires_at] ||
      checkout["expires_at"] ||
      checkout[:expiresAt] ||
      checkout["expiresAt"]
    Integer(provider_expiry || checkout_expiry)
  end
  private_class_method :attempt_expires_at
end
