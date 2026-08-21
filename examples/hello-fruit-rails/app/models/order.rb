# frozen_string_literal: true

class Order < ApplicationRecord
  self.primary_key = "id"

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

  private

  def assign_id
    self.id ||= SecureRandom.uuid
  end
end
