# frozen_string_literal: true

class CreateOrders < ActiveRecord::Migration[8.1]
  def change
    create_table :orders, id: :string do |t|
      t.string :currency, null: false, default: "USD"
      t.decimal :total, precision: 36, scale: 18, null: false
      t.string :status, null: false, default: "pending_payment"

      t.timestamps
    end
  end
end
