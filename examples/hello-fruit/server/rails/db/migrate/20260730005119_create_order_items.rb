# frozen_string_literal: true

class CreateOrderItems < ActiveRecord::Migration[8.1]
  def change
    create_table :order_items do |t|
      t.references :order, null: false, foreign_key: true, type: :string
      t.references :product, null: false, foreign_key: true, type: :string
      t.integer :quantity, null: false
      t.string :name, null: false
      t.string :sticker_path, null: false
      t.string :unit_amount_currency, null: false
      t.decimal :unit_amount_value, precision: 36, scale: 18, null: false
      t.string :line_amount_currency, null: false
      t.decimal :line_amount_value, precision: 36, scale: 18, null: false

      t.timestamps
    end
  end
end
