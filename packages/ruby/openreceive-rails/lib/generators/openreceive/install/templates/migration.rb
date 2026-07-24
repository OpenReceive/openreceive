# frozen_string_literal: true

class CreateOpenreceivePayments < ActiveRecord::Migration[<%= migration_version %>]
  def change
    create_table :openreceive_payments do |t|
      t.<%= order_primary_key_type %> :order_id, null: false
      t.string :payment_hash, null: false, limit: 64
      t.datetime :paid_at
      t.datetime :expires_at, null: false
      # Safe checkout response used for retry without another wallet call.
      t.json :checkout_data, null: false
      # Server-only provider recovery data. Never return or log this column.
      t.json :swap_data
      t.timestamps
    end

    add_index :openreceive_payments, :payment_hash, unique: true
    add_index :openreceive_payments, [:order_id, :created_at]
    add_index :openreceive_payments, [:paid_at, :created_at]
<% if add_order_foreign_key? -%>
    add_foreign_key :openreceive_payments, :<%= order_table_name %>, column: :order_id
<% end -%>

  end
end
