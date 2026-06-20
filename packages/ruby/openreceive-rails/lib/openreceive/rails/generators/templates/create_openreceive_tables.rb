# frozen_string_literal: true

class CreateOpenreceiveTables < ActiveRecord::Migration[7.1]
  def change
    create_table :openreceive_invoices, id: :string do |t|
      t.string :merchant_scope, null: false
      t.string :operation, null: false
      t.string :idempotency_key, null: false
      t.string :idempotency_request_hash, null: false
      t.string :payment_hash, null: false
      t.text :invoice, null: false
      t.bigint :amount_msats, null: false
      t.string :transaction_state, null: false
      t.string :workflow_state, null: false
      t.string :settlement_action_state, null: false
      t.bigint :created_at_seconds, null: false
      t.bigint :expires_at_seconds, null: false
      t.bigint :settled_at_seconds
      t.bigint :settlement_action_completed_at_seconds
      t.string :refreshed_from_invoice_id
      t.json :metadata, null: false, default: {}
      t.json :fiat_quote
      t.timestamps
    end

    add_index :openreceive_invoices,
              [:merchant_scope, :operation, :idempotency_key],
              unique: true,
              name: "idx_openreceive_invoice_idempotency"
    add_index :openreceive_invoices, :payment_hash, unique: true
    add_index :openreceive_invoices, :invoice, unique: true, length: 255
    add_index :openreceive_invoices, :transaction_state
    add_index :openreceive_invoices, :workflow_state

    add_check_constraint :openreceive_invoices,
                         "amount_msats >= 1000 AND amount_msats <= 9007199254740991",
                         name: "chk_openreceive_amount_msats"
    add_check_constraint :openreceive_invoices,
                         "transaction_state IN ('pending','settled','expired','failed','accepted')",
                         name: "chk_openreceive_transaction_state"
    add_check_constraint :openreceive_invoices,
                         "workflow_state IN ('draft','invoice_created','verifying','settlement_action_pending','settlement_action_completed','expiry_pending_verification','expired_closed','failed_closed','cancelled')",
                         name: "chk_openreceive_workflow_state"
    add_check_constraint :openreceive_invoices,
                         "settlement_action_state IN ('pending','completed','failed')",
                         name: "chk_openreceive_settlement_action_state"
  end
end
