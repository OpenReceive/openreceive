# frozen_string_literal: true

require "bigdecimal"
require "json"
require "uri"

module OpenReceive
  VERSION = "0.1.1"
  NWC_CODE_HELP_URL = "https://openreceive.org/get_a_nwc_code_to_receive_payments"
  NWC_METADATA_MAX_BYTES = 3900
  MIN_AMOUNT_MSATS = 1000
  MAX_AMOUNT_MSATS = 9_007_199_254_740_991
  HEX_64_PATTERN = /\A[0-9a-fA-F]{64}\z/.freeze

  class NwcUriParseError < StandardError
    attr_reader :code, :redacted

    def initialize(code, message, uri = nil)
      super(message)
      @code = code
      @redacted = uri.nil? ? nil : Nwc.redact_uri(uri)
    end
  end

  class WalletUnavailableError < StandardError
    attr_reader :status, :code

    def initialize(message = "NWC wallet service is unavailable.")
      super(message)
      @status = 503
      @code = "WALLET_UNAVAILABLE"
    end
  end

  module Money
    module_function

    def quote_fiat_to_sats(fiat_value:, btc_fiat_price:)
      fiat = decimal(fiat_value, "fiat.value")
      price = decimal(btc_fiat_price, "btc_fiat_price")
      raise ArgumentError, "btc_fiat_price must be greater than zero" unless price.positive?

      ((fiat * 100_000_000) / price).ceil
    end

    def quote_fiat_to_msats(fiat_value:, btc_fiat_price:)
      quote_fiat_to_sats(fiat_value: fiat_value, btc_fiat_price: btc_fiat_price) * 1000
    end

    def direct_to_msats(currency:, value:)
      amount = decimal(value, "amount.value")
      sats =
        case currency
        when "BTC" then amount * 100_000_000
        when "SAT", "SATS" then amount
        else raise ArgumentError, "amount.currency must be BTC, SAT, or SATS"
        end
      raise ArgumentError, "amount must resolve to whole satoshis" unless sats.frac.zero?

      bounded_msats(sats.to_i * 1000)
    end

    def bounded_msats(value)
      amount = Integer(value)
      unless amount.between?(MIN_AMOUNT_MSATS, MAX_AMOUNT_MSATS)
        raise ArgumentError, "amount_msats is outside the safe range"
      end
      amount
    end

    def decimal(value, field)
      text = value.to_s
      raise ArgumentError, "#{field} must be a positive decimal string" unless /\A[0-9]+(?:\.[0-9]+)?\z/.match?(text)
      parsed = BigDecimal(text)
      raise ArgumentError, "#{field} must be greater than zero" unless parsed.positive?
      parsed
    end
  end

  module Settlement
    module_function

    def settled?(transaction)
      data = stringify(transaction)
      data["settled_at"].to_i.positive? || data["state"] == "settled" || data["transaction_state"] == "settled"
    end

    def status(transaction)
      data = stringify(transaction)
      return "settled" if settled?(data)
      return "expired" if data["state"] == "expired" || data["transaction_state"] == "expired"
      return "failed" if data["state"] == "failed" || data["transaction_state"] == "failed"
      "pending"
    end

    def stringify(value)
      return {} unless value.respond_to?(:each_pair)
      value.each_pair.to_h { |key, item| [key.to_s, item] }
    end
  end

  module Nwc
    module_function

    def make_invoice_request(request)
      data = stringify(request)
      if present?(data["description"]) && present?(data["description_hash"])
        raise ArgumentError, "description and description_hash cannot both be set"
      end
      if data.key?("description_hash") && !HEX_64_PATTERN.match?(data["description_hash"].to_s)
        raise ArgumentError, "description_hash must be 64 hex characters"
      end
      result = { "amount" => Money.bounded_msats(data.fetch("amount_msats")) }
      result["description"] = data["description"] if data.key?("description")
      result["description_hash"] = data["description_hash"] if data.key?("description_hash")
      result["expiry"] = Integer(data["expiry"]) if data.key?("expiry")
      if data.key?("metadata")
        raise ArgumentError, "metadata is too large" if JSON.generate(data["metadata"]).bytesize > NWC_METADATA_MAX_BYTES
        result["metadata"] = data["metadata"]
      end
      result
    end

    def normalize_make_invoice_response(response)
      data = stringify(unwrap(response))
      {
        "invoice" => data.fetch("invoice"),
        "payment_hash" => (data["payment_hash"] || data["paymentHash"]).to_s.downcase,
        "amount_msats" => Integer(data["amount_msats"] || data["amount"]),
        "created_at" => optional_integer(data["created_at"] || data["createdAt"]),
        "expires_at" => optional_integer(data["expires_at"] || data["expiresAt"])
      }.compact
    end

    def list_transactions_request(request)
      data = stringify(request)
      result = {}
      %w[from until offset limit].each { |key| result[key] = Integer(data[key]) if data.key?(key) }
      result["type"] = data["type"] if data.key?("type")
      result["unpaid"] = data["unpaid"] if data.key?("unpaid")
      raise ArgumentError, "limit must be at most 20" if result["limit"].to_i > 20
      result
    end

    def normalize_list_transactions_response(response)
      unwrapped = unwrap(response)
      data = stringify(unwrapped)
      rows = data["transactions"] || (unwrapped.is_a?(Array) ? unwrapped : [])
      { "transactions" => Array(rows).map { |row| normalize_transaction(row) } }
    end

    def normalize_transaction(transaction)
      data = stringify(transaction)
      {
        "type" => data["type"],
        "invoice" => data["invoice"],
        "payment_hash" => (data["payment_hash"] || data["paymentHash"])&.downcase,
        "amount_msats" => optional_integer(data["amount_msats"] || data["amount"]),
        "transaction_state" => (data["transaction_state"] || data["transactionState"] || data["state"])&.downcase,
        "created_at" => optional_integer(data["created_at"] || data["createdAt"]),
        "expires_at" => optional_integer(data["expires_at"] || data["expiresAt"]),
        "settled_at" => optional_integer(data["settled_at"] || data["settledAt"]),
        "preimage" => data["preimage"]
      }.compact
    end

    def parse_uri(uri)
      parsed = URI.parse(uri)
      raise NwcUriParseError.new("invalid_scheme", "NWC URI must use nostr+walletconnect.", uri) unless parsed.scheme == "nostr+walletconnect"
      wallet = parsed.host.to_s.empty? ? parsed.path.to_s.sub(%r{\A/+}, "") : parsed.host
      raise NwcUriParseError.new("invalid_wallet_pubkey", "NWC wallet public key must be 64 hex characters.", uri) unless HEX_64_PATTERN.match?(wallet)
      pairs = URI.decode_www_form(parsed.query.to_s)
      relays = pairs.filter_map { |key, value| value if key == "relay" }
      secrets = pairs.filter_map { |key, value| value if key == "secret" }
      raise NwcUriParseError.new("missing_relay", "NWC URI must include a relay.", uri) if relays.empty?
      raise NwcUriParseError.new("invalid_secret", "NWC URI must include one 64-hex secret.", uri) unless secrets.length == 1 && HEX_64_PATTERN.match?(secrets.first)
      { wallet_pubkey: wallet, relays: relays, client_secret: secrets.first, redacted: redact_uri(uri) }
    rescue URI::InvalidURIError
      raise NwcUriParseError.new("invalid_uri", "Invalid NWC URI.", uri)
    end

    def redact_uri(uri)
      uri.to_s.gsub(/([?&]secret=)[^&#]*/i, '\\1[REDACTED]')
    end

    def stringify(value)
      return {} unless value.respond_to?(:each_pair)
      value.each_pair.to_h { |key, item| [key.to_s, item] }
    end

    def unwrap(value)
      data = stringify(value)
      data.key?("result") ? data["result"] : value
    end

    def optional_integer(value)
      value.nil? ? nil : Integer(value)
    end

    def present?(value)
      !value.nil? && value != ""
    end
  end

  module_function

  def quote_fiat_to_msats(fiat_value:, btc_fiat_price:)
    Money.quote_fiat_to_msats(fiat_value: fiat_value, btc_fiat_price: btc_fiat_price)
  end

  def settled?(transaction)
    Settlement.settled?(transaction)
  end

  def parse_nwc_uri(uri)
    Nwc.parse_uri(uri)
  end

  def redact_nwc_uri(uri)
    Nwc.redact_uri(uri)
  end

  def make_invoice_nip47_request(request)
    Nwc.make_invoice_request(request)
  end

  def normalize_make_invoice_response(response)
    Nwc.normalize_make_invoice_response(response)
  end

  def list_transactions_nip47_request(request)
    Nwc.list_transactions_request(request)
  end

  def normalize_list_transactions_response(response)
    Nwc.normalize_list_transactions_response(response)
  end
end

require_relative "openreceive/nwc_ruby"
