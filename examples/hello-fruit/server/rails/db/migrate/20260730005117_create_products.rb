# frozen_string_literal: true

class CreateProducts < ActiveRecord::Migration[8.1]
  def change
    create_table :products, id: :string do |t|
      t.string :name, null: false
      t.string :sticker_path, null: false
      t.string :price_currency, null: false, default: "USD"
      t.decimal :price_value, precision: 36, scale: 18, null: false

      t.timestamps
    end
  end
end
