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

ActiveRecord::Schema[8.1].define(version: 2026_08_19_000001) do
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
    t.string "order_id", null: false
    t.datetime "paid_at"
    t.string "payment_hash", limit: 64, null: false
    t.string "status", default: "pending", null: false
    t.string "status_reason"
    t.json "swap_data"
    t.datetime "updated_at", null: false
    t.index ["client_ip", "inserted_at"], name: "index_openreceive_payments_on_client_ip_and_inserted_at"
    t.index ["order_id", "created_at"], name: "index_openreceive_payments_on_order_id_and_created_at"
    t.index ["payment_hash"], name: "index_openreceive_payments_on_payment_hash", unique: true
    t.index ["status", "created_at"], name: "index_openreceive_payments_on_status_and_created_at"
    t.check_constraint "payment_hash::text ~ '^[0-9a-f]{64}$'::text", name: "openreceive_payments_payment_hash_check"
    t.check_constraint "status::text = ANY (ARRAY['pending'::character varying::text, 'settled'::character varying::text, 'expired'::character varying::text, 'failed'::character varying::text, 'attention'::character varying::text])", name: "openreceive_payments_status_check"
  end

  create_table "order_items", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "line_amount_currency", null: false
    t.decimal "line_amount_value", precision: 36, scale: 18, null: false
    t.string "name", null: false
    t.string "order_id", null: false
    t.string "product_id", null: false
    t.integer "quantity", null: false
    t.string "sticker_path", null: false
    t.string "unit_amount_currency", null: false
    t.decimal "unit_amount_value", precision: 36, scale: 18, null: false
    t.datetime "updated_at", null: false
    t.index ["order_id"], name: "index_order_items_on_order_id"
    t.index ["product_id"], name: "index_order_items_on_product_id"
  end

  create_table "orders", id: :string, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "currency", default: "USD", null: false
    t.string "status", default: "pending_payment", null: false
    t.decimal "total", precision: 36, scale: 18, null: false
    t.datetime "updated_at", null: false
  end

  create_table "products", id: :string, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "name", null: false
    t.string "price_currency", default: "USD", null: false
    t.decimal "price_value", precision: 36, scale: 18, null: false
    t.string "sticker_path", null: false
    t.datetime "updated_at", null: false
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

  add_foreign_key "openreceive_payments", "orders"
  add_foreign_key "order_items", "orders"
  add_foreign_key "order_items", "products"
end
