# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_08_27_000006) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

  create_table "openreceive_meta", primary_key: "key", id: :string, force: :cascade do |t|
    t.bigint "rev", default: 0, null: false
    t.text "value", null: false
  end

  create_table "openreceive_payments", force: :cascade do |t|
    t.json "checkout_data", null: false
    t.string "client_ip"
    t.datetime "created_at", null: false
    t.datetime "expires_at", null: false
    t.datetime "inserted_at", null: false
    t.datetime "paid_at"
    t.string "payment_hash", limit: 64, null: false
    t.string "reference", null: false
    t.string "status", default: "pending", null: false
    t.string "status_reason"
    t.json "swap_data"
    t.datetime "updated_at", null: false
    t.index ["client_ip", "inserted_at"], name: "index_openreceive_payments_on_client_ip_and_inserted_at"
    t.index ["payment_hash"], name: "index_openreceive_payments_on_payment_hash", unique: true
    t.index ["reference", "created_at"], name: "index_openreceive_payments_on_reference_and_created_at"
    t.index ["status", "created_at"], name: "index_openreceive_payments_on_status_and_created_at"
    t.check_constraint "payment_hash::text ~ '^[0-9a-f]{64}$'::text", name: "openreceive_payments_payment_hash_check"
    t.check_constraint "status::text = ANY (ARRAY['pending'::character varying::text, 'settled'::character varying::text, 'expired'::character varying::text, 'failed'::character varying::text, 'attention'::character varying::text])", name: "openreceive_payments_status_check"
  end

  create_table "shop_order_items", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "name", null: false
    t.uuid "product_id"
    t.integer "quantity", null: false
    t.uuid "shop_order_id", null: false
    t.string "sku", null: false
    t.integer "unit_price_cents", null: false
    t.datetime "updated_at", null: false
    t.index ["product_id"], name: "index_shop_order_items_on_product_id"
    t.index ["shop_order_id", "sku"], name: "index_shop_order_items_on_shop_order_id_and_sku", unique: true
    t.check_constraint "quantity > 0", name: "shop_order_items_quantity_check"
    t.check_constraint "unit_price_cents > 0", name: "shop_order_items_unit_price_cents_check"
  end

  create_table "shop_orders", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "currency", default: "USD", null: false
    t.datetime "paid_at"
    t.string "payment_hash"
    t.uuid "shop_user_id", null: false
    t.string "state", default: "awaiting_payment", null: false
    t.integer "total_cents", null: false
    t.datetime "updated_at", null: false
    t.index ["shop_user_id"], name: "index_shop_orders_on_shop_user_id"
    t.index ["state", "created_at"], name: "index_shop_orders_on_state_and_created_at"
    t.index ["state", "paid_at"], name: "index_shop_orders_on_state_and_paid_at"
    t.check_constraint "state::text = ANY (ARRAY['awaiting_payment'::character varying::text, 'paid'::character varying::text])", name: "shop_orders_state_check"
    t.check_constraint "total_cents > 0", name: "shop_orders_total_cents_check"
  end

  create_table "shop_products", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.boolean "active", default: true, null: false
    t.datetime "created_at", null: false
    t.string "image_name", null: false
    t.string "name", null: false
    t.integer "position", default: 0, null: false
    t.integer "price_cents", null: false
    t.string "sku", null: false
    t.datetime "updated_at", null: false
    t.index ["active", "position"], name: "index_shop_products_on_active_and_position"
    t.index ["sku"], name: "index_shop_products_on_sku", unique: true
    t.check_constraint "price_cents > 0", name: "shop_products_price_cents_check"
  end

  create_table "shop_users", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "first_seen_at", null: false
    t.datetime "last_seen_at", null: false
    t.uuid "public_ref", default: -> { "gen_random_uuid()" }, null: false
    t.datetime "updated_at", null: false
    t.index ["public_ref"], name: "index_shop_users_on_public_ref", unique: true
  end

  create_table "solid_cable_messages", force: :cascade do |t|
    t.binary "channel", null: false
    t.bigint "channel_hash", null: false
    t.datetime "created_at", null: false
    t.binary "payload", null: false
    t.index ["channel"], name: "index_solid_cable_messages_on_channel"
    t.index ["channel_hash"], name: "index_solid_cable_messages_on_channel_hash"
    t.index ["created_at"], name: "index_solid_cable_messages_on_created_at"
  end

  add_foreign_key "shop_order_items", "shop_orders"
  add_foreign_key "shop_order_items", "shop_products", column: "product_id", on_delete: :nullify
  add_foreign_key "shop_orders", "shop_users"
end
