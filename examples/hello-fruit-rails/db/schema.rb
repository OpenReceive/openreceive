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

ActiveRecord::Schema[8.1].define(version: 2026_07_30_005116) do
  create_table "openreceive_meta", primary_key: "key", id: :string, force: :cascade do |t|
    t.bigint "rev", default: 0, null: false
    t.text "value", null: false
  end

  create_table "openreceive_payments", force: :cascade do |t|
    t.json "checkout_data", null: false
    t.string "client_ip"
    t.datetime "created_at", null: false
    t.datetime "expires_at", null: false
    t.string "order_id", null: false
    t.datetime "paid_at"
    t.string "payment_hash", limit: 64, null: false
    t.string "status", default: "pending", null: false
    t.string "status_reason"
    t.json "swap_data"
    t.datetime "updated_at", null: false
    t.index ["client_ip", "created_at"], name: "index_openreceive_payments_on_client_ip_and_created_at"
    t.index ["order_id", "created_at"], name: "index_openreceive_payments_on_order_id_and_created_at"
    t.index ["payment_hash"], name: "index_openreceive_payments_on_payment_hash", unique: true
    t.index ["status", "created_at"], name: "index_openreceive_payments_on_status_and_created_at"
  end

  create_table "orders", id: :string, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "currency", default: "USD", null: false
    t.string "status", default: "pending_payment", null: false
    t.decimal "total", precision: 36, scale: 18, null: false
    t.datetime "updated_at", null: false
  end
end
