# frozen_string_literal: true

# The order and its items, in one migration because neither is useful alone.
#
# `shop_orders.id` IS the OpenReceive reference: minted before checkout, kept
# across every retry, never reused.
#
# `shop_user_id` is NOT NULL. This is a fresh demo; there are no legacy rows to
# survive. There is also no `session_token` column, in any stack — the signed
# cookie is the only ownership mechanism, and two sources of ownership truth is
# the thing this design exists to avoid.
class CreateShopOrders < ActiveRecord::Migration[8.1]
  def change
    create_table :shop_orders, id: :uuid do |t|
      t.references :shop_user, null: false, foreign_key: true, type: :uuid, index: false
      t.string :state, null: false, default: "awaiting_payment"
      t.integer :total_cents, null: false
      t.string :currency, null: false, default: "USD"
      t.datetime :paid_at
      t.string :payment_hash

      t.timestamps
    end

    add_index :shop_orders, :shop_user_id
    add_index :shop_orders, [:state, :created_at]
    # The public feed's index: paid rows, newest first.
    add_index :shop_orders, [:state, :paid_at]

    add_check_constraint :shop_orders, "state IN ('awaiting_payment', 'paid')",
                         name: "shop_orders_state_check"
    add_check_constraint :shop_orders, "total_cents > 0",
                         name: "shop_orders_total_cents_check"

    create_table :shop_order_items, id: :uuid do |t|
      t.references :shop_order, null: false, foreign_key: true, type: :uuid, index: false
      # Nullable, with the snapshots beside it: the FK is for joins, the
      # snapshot is what renders. An item row must stay readable after its
      # product is deleted, and history must not move when the catalog does.
      t.references :product, null: true, type: :uuid, index: false,
                   foreign_key: { to_table: :shop_products, on_delete: :nullify }
      t.string :sku, null: false
      t.string :name, null: false
      t.integer :unit_price_cents, null: false
      t.integer :quantity, null: false

      t.timestamps
    end

    # One line per sku per order: `normalized_lines` merges duplicates, and this
    # is the database saying so too.
    add_index :shop_order_items, [:shop_order_id, :sku], unique: true
    add_index :shop_order_items, :product_id

    add_check_constraint :shop_order_items, "quantity > 0",
                         name: "shop_order_items_quantity_check"
    add_check_constraint :shop_order_items, "unit_price_cents > 0",
                         name: "shop_order_items_unit_price_cents_check"
  end
end
