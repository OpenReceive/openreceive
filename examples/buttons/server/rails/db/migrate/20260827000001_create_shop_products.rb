# frozen_string_literal: true

# The price authority, as a table.
#
# There is no transition sequence here, no backfill and no second deploy: this
# schema is created once, correct. A reference app that ships its author's
# migration scaffolding teaches the wrong lesson.
class CreateShopProducts < ActiveRecord::Migration[8.1]
  def change
    create_table :shop_products, id: :uuid do |t|
      t.string :sku, null: false
      t.string :name, null: false
      t.integer :price_cents, null: false
      t.integer :position, null: false, default: 0
      # A FILENAME, not bytes and not an attachment. See
      # config/initializers/assets.rb for why there is no ActiveStorage here,
      # and app/models/shop_product.rb for why this is a column rather than a
      # derivation from the sku.
      t.string :image_name, null: false
      t.boolean :active, null: false, default: true

      t.timestamps
    end

    add_index :shop_products, :sku, unique: true
    add_index :shop_products, [:active, :position]

    add_check_constraint :shop_products, "price_cents > 0",
                         name: "shop_products_price_cents_check"
  end
end
