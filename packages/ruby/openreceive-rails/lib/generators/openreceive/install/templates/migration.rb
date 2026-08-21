# frozen_string_literal: true

# Both engine-owned tables, in one migration: the payment attempts and the
# durable reconcile gate they share. Same host database, never a second one.
class CreateOpenreceiveTables < ActiveRecord::Migration[<%= migration_version %>]
  def change
    create_table :openreceive_payments do |t|
      t.<%= order_primary_key_type %> :order_id, null: false
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
      # Immutable local-clock stamp the rate limiter windows on. created_at is
      # the wallet-reported invoice time (a skewed wallet clock would move the
      # window) and updated_at moves on every status transition (which would
      # re-enter an old attempt into the current window).
      t.datetime :inserted_at, null: false
      t.timestamps
    end

    add_index :openreceive_payments, :payment_hash, unique: true
    add_index :openreceive_payments, [:order_id, :created_at]
    add_index :openreceive_payments, [:status, :created_at]
    add_index :openreceive_payments, [:client_ip, :inserted_at]
<% if add_order_foreign_key? -%>
    add_foreign_key :openreceive_payments, :<%= order_table_name %>, column: :order_id
<% end -%>

    # Engine-owned key/value/rev rows: the durable reconcile gate every worker
    # on this database shares, so settlement scans piggybacking on requests
    # collapse to one real wallet call per interval. Same host database as
    # openreceive_payments, never a second one.
    create_table :openreceive_meta, id: false do |t|
      t.string :key, null: false, primary_key: true
      t.text :value, null: false
      t.bigint :rev, null: false, default: 0
    end

    # Database-level backstops for the two invariants the engines enforce in
    # code, mirroring the JS openReceivePaymentsSchemaSql. There is deliberately
    # NO uniqueness constraint over live attempts: liveness is time-dependent
    # (a superseded row stays pending with a future expires_at, and an expired
    # row stays pending until a wallet scan closes it), so any such index would
    # reject legitimate reminting.
    add_check_constraint :openreceive_payments,
                         "status IN ('pending', 'settled', 'expired', 'failed', 'attention')",
                         name: "openreceive_payments_status_check"
    add_check_constraint :openreceive_payments,
                         <%= payment_hash_check_sql %>,
                         name: "openreceive_payments_payment_hash_check"

    # Which schema generation is installed. The engine refuses to run against a
    # generation newer than the library it is linked with.
    reversible do |direction|
      direction.up do
<% if mysql_adapter? -%>
        execute(<<~SQL.squish)
          INSERT IGNORE INTO openreceive_meta (`key`, value, rev)
          VALUES ('schema_version', '<%= schema_version %>', 0)
        SQL
<% else -%>
        execute(<<~SQL.squish)
          INSERT INTO openreceive_meta (key, value, rev)
          VALUES ('schema_version', '<%= schema_version %>', 0)
          ON CONFLICT (key) DO NOTHING
        SQL
<% end -%>
      end
    end
  end
end
