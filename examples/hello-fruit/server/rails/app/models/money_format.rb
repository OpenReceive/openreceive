# frozen_string_literal: true

# Exact decimal string for amounts (no binary float). Pads known fiat currencies
# to their minor-unit width so USD totals render as "2.00" instead of
# BigDecimal#to_s("F")'s "2.0".
module MoneyFormat
  module_function

  MIN_FRACTION_DIGITS = {
    "USD" => 2
  }.freeze

  def call(value, currency: nil)
    text = decimal_text(value)
    digits = MIN_FRACTION_DIGITS[currency.to_s.upcase]
    if digits
      whole, fraction = text.split(".", 2)
      fraction = (fraction || "").ljust(digits, "0")
      return "#{whole}.#{fraction}"
    end

    # Integer-valued amounts (sats) should not keep BigDecimal's trailing ".0".
    text.sub(/\.0\z/, "")
  end

  def decimal_text(value)
    if value.is_a?(String)
      text = value.strip
      raise ArgumentError, "amount must be a non-negative decimal" unless text.match?(/\A[0-9]+(?:\.[0-9]+)?\z/)

      return text
    end

    BigDecimal(value.to_s).to_s("F")
  end
  private_class_method :decimal_text
end
