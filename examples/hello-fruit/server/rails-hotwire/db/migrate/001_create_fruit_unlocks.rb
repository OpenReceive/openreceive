class CreateFruitUnlocks < ActiveRecord::Migration[7.1]
  def change
    create_table :fruit_unlocks do |t|
      t.string :invoice_id, null: false
      t.string :fruit, null: false
      t.string :payment_hash, null: false
      t.timestamps
    end

    add_index :fruit_unlocks, :invoice_id, unique: true
    add_index :fruit_unlocks, :payment_hash
  end
end
