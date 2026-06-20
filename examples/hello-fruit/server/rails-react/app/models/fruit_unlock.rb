class FruitUnlock < ActiveRecord::Base
  validates :invoice_id, :fruit, :payment_hash, presence: true
  validates :invoice_id, uniqueness: true
end
