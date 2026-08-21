# frozen_string_literal: true

class OrderItem < ApplicationRecord
  belongs_to :order, inverse_of: :order_items
  belongs_to :product

  validates :quantity, numericality: { only_integer: true, greater_than: 0 }
  validates :name, :sticker_path, :unit_amount_currency, :line_amount_currency, presence: true
  validates :unit_amount_value, :line_amount_value, presence: true, numericality: { greater_than: 0 }

  def as_summary
    {
      product_id: product_id,
      name: name,
      sticker: sticker_path,
      quantity: quantity,
      unit_amount: { currency: unit_amount_currency, value: MoneyFormat.call(unit_amount_value, currency: unit_amount_currency) },
      line_amount: { currency: line_amount_currency, value: MoneyFormat.call(line_amount_value, currency: line_amount_currency) }
    }
  end
end
