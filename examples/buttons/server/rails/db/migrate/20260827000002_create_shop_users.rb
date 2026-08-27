# frozen_string_literal: true

# A visitor: two uuids and two timestamps. No email, no name, no password, no
# IP, no OAuth — a user with no credentials is the feature.
#
# `id` is the ownership token that lives in the signed cookie and is never
# rendered. `public_ref` is the handle the recent-orders feed shows. See
# app/models/shop_user.rb for why that is two columns rather than one.
class CreateShopUsers < ActiveRecord::Migration[8.1]
  def change
    create_table :shop_users, id: :uuid do |t|
      t.uuid :public_ref, null: false, default: -> { "gen_random_uuid()" }
      t.datetime :first_seen_at, null: false
      t.datetime :last_seen_at, null: false

      t.timestamps
    end

    add_index :shop_users, :public_ref, unique: true
  end
end
