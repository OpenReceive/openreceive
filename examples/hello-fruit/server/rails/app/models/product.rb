# frozen_string_literal: true

class Product < ApplicationRecord
  self.primary_key = "id"

  has_many :order_items, dependent: :restrict_with_exception

  validates :name, :sticker_path, :price_currency, :price_value, presence: true
  validates :price_value, numericality: { greater_than: 0 }

  def sticker_public_path
    "/stickers/#{File.basename(sticker_path)}"
  end

  def amount
    { currency: price_currency, value: MoneyFormat.call(price_value, currency: price_currency) }
  end
end

