# frozen_string_literal: true

# Builds a host Order from cart lines priced against Product rows (not payer input).
# Mirrors examples/hello-fruit/shared/demo-prepare-checkout.ts currency handling.
class CreateFruitOrder
  class Error < StandardError; end

  DIRECT_CURRENCIES = %w[BTC SATS].freeze
  SUPPORTED = (%w[USD] + DIRECT_CURRENCIES).freeze

  def self.call(cart:, currency: "USD")
    new(cart: cart, currency: currency).call
  end

  def initialize(cart:, currency:)
    @cart = Array(cart)
    @currency = normalize_currency(currency)
  end

  def call
    raise Error, "Cart must include at least one item." if @cart.empty?
    raise Error, "Cart can include at most 12 items." if @cart.length > 12

    rates = order_rates
    lines = merge_quantities(@cart)
    Order.transaction do
      order = Order.new(currency: @currency, status: "pending_payment", total: 0)
      total = BigDecimal("0")
      lines.each do |product_id, quantity|
        product = Product.find(product_id)
        unit = convert_unit(product, rates)
        line_total = unit * quantity
        total += line_total
        order.order_items.build(
          product: product,
          quantity: quantity,
          name: product.name,
          sticker_path: product.sticker_path,
          unit_amount_currency: @currency,
          unit_amount_value: unit,
          line_amount_currency: @currency,
          line_amount_value: line_total
        )
      end
      order.total = total
      order.save!
      order
    end
  end

  private

  def normalize_currency(value)
    currency = value.to_s.strip.upcase
    currency = "USD" if currency.empty?
    raise Error, "Unsupported currency: #{currency}." unless SUPPORTED.include?(currency)

    currency
  end

  def merge_quantities(cart)
    quantities = Hash.new(0)
    cart.each do |entry|
      data = entry.respond_to?(:to_unsafe_h) ? entry.to_unsafe_h : entry.to_h
      data = data.with_indifferent_access
      product_id = (data[:product_id].presence || data[:id]).to_s
      quantity = Integer(data[:quantity] || 1)
      raise Error, "product_id is required." if product_id.blank?
      raise Error, "Cart item quantity must be an integer from 1 to 99." unless quantity.between?(1, 99)
      raise Error, "Unknown product: #{product_id}." unless Product.exists?(product_id)

      quantities[product_id] += quantity
    end
    quantities
  end

  def order_rates
    return nil if @currency == "USD"

    OpenReceive.config.service.list_rates("currencies" => ["USD"]).fetch("bitcoin")
  end

  def convert_unit(product, rates)
    usd = product.price_value
    return usd if @currency == "USD"

    price = rates&.fetch("usd") { raise Error, "missing BTC/USD rate" }
    sats = OpenReceive::Money.quote_fiat_to_sats(fiat_value: usd.to_s("F"), btc_fiat_price: price)
    return BigDecimal(sats.to_s) if @currency == "SATS"

    BigDecimal(sats) / BigDecimal("100000000")
  end
end
