# frozen_string_literal: true

# solid_cable single-database setup: the messages table lives in the primary
# database (see config/cable.yml), so the reconciler and notifications worker
# containers can broadcast into Puma through the DB they already share.
class CreateSolidCableMessages < ActiveRecord::Migration[8.1]
  def change
    create_table :solid_cable_messages do |t|
      t.binary :channel, limit: 1024, null: false
      t.binary :payload, limit: 536_870_912, null: false
      t.datetime :created_at, null: false
      t.integer :channel_hash, limit: 8, null: false

      t.index :channel
      t.index :channel_hash
      t.index :created_at
    end
  end
end
