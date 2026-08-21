# frozen_string_literal: true

class Order < ApplicationRecord
  self.primary_key = "id"

  has_many :order_items, dependent: :destroy, inverse_of: :order
  # OpenReceivePayment is engine-owned (openreceive-rails); only the table
  # lives in this app's database.
  has_many :open_receive_payments, dependent: :restrict_with_exception

  STATUSES = %w[pending_payment paid].freeze

  validates :currency, presence: true
  validates :total, presence: true, numericality: { greater_than: 0 }
  validates :status, inclusion: { in: STATUSES }

  before_validation :assign_id, on: :create

  def mark_paid!
    update!(status: "paid")
  end

  # Push the current summary to any browser watching this order (ls-style
  # explicit broadcast, no callbacks). Reload first so an out-of-process
  # caller never pushes a stale in-memory status.
  def broadcast_order_update
    reload if persisted?
    OrderChannel.broadcast_to(id, "message" => "order-update", "data" => summary)
  end

  def summary
    {
      uuid: id,
      status: status,
      items: order_items.map(&:as_summary),
      total_amount: { currency: currency, value: MoneyFormat.call(total, currency: currency) }
    }
  end

  private

  def assign_id
    self.id ||= "rails-#{SecureRandom.uuid}"
  end
end
