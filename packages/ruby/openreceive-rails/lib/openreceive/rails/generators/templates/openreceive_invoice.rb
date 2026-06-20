# frozen_string_literal: true

class OpenReceiveInvoice < ApplicationRecord
  self.table_name = "openreceive_invoices"

  validates :merchant_scope, :operation, :idempotency_key, presence: true
  validates :idempotency_request_hash, format: { with: /\Asha256:[0-9a-f]{64}\z/ }
  validates :payment_hash, :invoice, presence: true, uniqueness: true
  validates :amount_msats,
            numericality: {
              only_integer: true,
              greater_than_or_equal_to: 1000,
              less_than_or_equal_to: 9_007_199_254_740_991
            }

  enum :transaction_state,
       {
         pending: "pending",
         settled: "settled",
         expired: "expired",
         failed: "failed",
         accepted: "accepted"
       },
       prefix: true

  enum :workflow_state,
       {
         draft: "draft",
         invoice_created: "invoice_created",
         verifying: "verifying",
         settlement_action_pending: "settlement_action_pending",
         settlement_action_completed: "settlement_action_completed",
         expiry_pending_verification: "expiry_pending_verification",
         expired_closed: "expired_closed",
         failed_closed: "failed_closed",
         cancelled: "cancelled"
       },
       prefix: true

  enum :settlement_action_state,
       {
         pending: "pending",
         completed: "completed",
         failed: "failed"
       },
       prefix: true
end
