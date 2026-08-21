# frozen_string_literal: true

# Both engine-owned tables, in one migration: the payment attempts and the
# durable reconcile gate they share. Same host database, never a second one.
class CreateOpenreceiveTables < ActiveRecord::Migration[8.1]
  def change
    create_table :openreceive_payments do |t|
      t.string :order_id, null: false
      t.string :payment_hash, null: false, limit: 64
      # Attempt lifecycle: pending | settled | expired | failed | attention.
      t.string :status, null: false, default: "pending"
      # Operator-facing detail for the current status (e.g. "superseded").
      t.string :status_reason
      t.datetime :paid_at
      t.datetime :expires_at, null: false
      # Safe checkout response used for retry without another wallet call.
      t.json :checkout_data, null: false
      # Server-only provider recovery data. Never return or log this column.
      t.json :swap_data
      # Client IP captured at invoice creation; backs optional per-IP rate limiting.
      t.string :client_ip
      t.timestamps
    end

    add_index :openreceive_payments, :payment_hash, unique: true
    add_index :openreceive_payments, [:order_id, :created_at]
    add_index :openreceive_payments, [:status, :created_at]
    add_index :openreceive_payments, [:client_ip, :created_at]
    add_foreign_key :openreceive_payments, :orders, column: :order_id

    # Engine-owned key/value/rev rows: the durable reconcile gate every worker
    # on this database shares, so settlement scans piggybacking on requests
    # collapse to one real wallet call per interval. Same host database as
    # openreceive_payments, never a second one.
    create_table :openreceive_meta, id: false do |t|
      t.string :key, null: false, primary_key: true
      t.text :value, null: false
      t.bigint :rev, null: false, default: 0
    end
  end
end
