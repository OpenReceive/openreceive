# frozen_string_literal: true

require "bigdecimal"
require "json"
require "uri"

require_relative "openreceive/version"

module OpenReceive
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
      # Bounded like every other amount path (and like the JS quote): a large
      # enough fiat value at a low enough price otherwise produces an
      # amount_msats past the wire contract's 2^53-1 ceiling.
      bounded_msats(quote_fiat_to_sats(fiat_value: fiat_value, btc_fiat_price: btc_fiat_price) * 1000)
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
      # Mirrors JS: limit must be a positive integer; no hard page cap here
      # (OpenReceive's own scans use PAGE_LIMIT, but the mapper passes callers'
      # limits through).
      raise ArgumentError, "limit must be a positive integer" if result.key?("limit") && result["limit"] <= 0
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

    # Mirrors JS parseNwcUri: same error codes for the same failures so both
    # engines pass the shared nwc-uri-parse vectors.
    def parse_uri(uri)
      raise NwcUriParseError.new("invalid_uri", "Invalid NWC URI.", nil) unless uri.is_a?(String) && !uri.strip.empty?
      parsed = URI.parse(uri)
      raise NwcUriParseError.new("invalid_scheme", "NWC URI must use nostr+walletconnect.", uri) unless parsed.scheme == "nostr+walletconnect"
      # Opaque form (`nostr+walletconnect:<pubkey>?...`, no slashes): Ruby's
      # URI keeps "<pubkey>?query" whole in #opaque with #query nil, while
      # JS's WHATWG URL exposes it as pathname + searchParams — split it here
      # so both engines accept the same URIs.
      if parsed.host.to_s.empty? && !parsed.opaque.nil?
        wallet, separator, query = parsed.opaque.to_s.partition("?")
        query = parsed.query if separator.empty?
      else
        wallet = parsed.host.to_s.empty? ? parsed.path.to_s.sub(%r{\A/+}, "") : parsed.host
        query = parsed.query
      end
      raise NwcUriParseError.new("missing_wallet_pubkey", "NWC URI is missing the wallet public key.", uri) if wallet.to_s.empty?
      raise NwcUriParseError.new("invalid_wallet_pubkey", "NWC wallet public key must be 64 hex characters.", uri) unless HEX_64_PATTERN.match?(wallet)
      pairs = URI.decode_www_form(query.to_s)
      relays = pairs.filter_map { |key, value| value if key == "relay" }
      secrets = pairs.filter_map { |key, value| value if key == "secret" }
      raise NwcUriParseError.new("missing_relay", "NWC URI must include at least one relay.", uri) if relays.empty?
      relays.each do |relay|
        raise NwcUriParseError.new("invalid_relay", "NWC relay URLs must be valid wss URLs.", uri) unless valid_relay_url?(relay)
      end
      raise NwcUriParseError.new("missing_secret", "NWC URI is missing the client secret.", uri) if secrets.empty? || secrets.first.to_s.empty?
      unless secrets.length == 1 && HEX_64_PATTERN.match?(secrets.first)
        raise NwcUriParseError.new("invalid_secret", "NWC client secret must be 64 hex characters.", uri)
      end
      lud16 = pairs.filter_map { |key, value| value if key == "lud16" }.first
      result = { wallet_pubkey: wallet, relays: relays, client_secret: secrets.first, redacted: redact_uri(uri) }
      result[:lud16] = lud16 unless lud16.nil? || lud16.empty?
      result
    rescue URI::InvalidURIError
      raise NwcUriParseError.new("invalid_uri", "Invalid NWC URI.", uri)
    end

    def valid_relay_url?(relay)
      parsed = URI.parse(relay.to_s)
      parsed.scheme == "wss" && !parsed.host.to_s.empty?
    rescue URI::InvalidURIError
      false
    end

    # Redacts every query pair whose PERCENT-DECODED key is "secret" (JS
    # decodes keys first, so %73ecret= must not slip past redaction). Other
    # pairs keep their original bytes.
    def redact_uri(uri)
      text = uri.to_s
      query_start = text.index("?")
      return text if query_start.nil?
      fragment_start = text.index("#", query_start + 1)
      query_end = fragment_start.nil? ? text.length : fragment_start
      query = text[(query_start + 1)...query_end]
      redacted = query.split("&", -1).map do |pair|
        separator = pair.index("=")
        key = separator.nil? ? pair : pair[0...separator]
        decoded_key = begin
          URI.decode_www_form_component(key)
        rescue ArgumentError
          key
        end
        decoded_key.downcase == "secret" && !separator.nil? ? "#{key}=[REDACTED]" : pair
      end.join("&")
      "#{text[0..query_start]}#{redacted}#{text[query_end..]}"
    end

    # Canonical OpenReceive error codes (mirrors the JS generated contract).
    ERROR_CODES = %w[
      NOT_IMPLEMENTED RESTRICTED UNAUTHORIZED RATE_LIMITED QUOTA_EXCEEDED
      INTERNAL UNSUPPORTED_ENCRYPTION INSUFFICIENT_BALANCE PAYMENT_FAILED
      OTHER NOT_FOUND TIMEOUT INVALID_REQUEST WALLET_UNAVAILABLE
      INVOICE_EXPIRED UNSUPPORTED_METHOD CONFLICT
    ].freeze
    RETRYABLE_ERROR_CODES = %w[RATE_LIMITED QUOTA_EXCEEDED TIMEOUT WALLET_UNAVAILABLE INTERNAL].freeze
    # Wallet/library spellings that map onto canonical codes (mirrors JS
    # NWC_ERROR_CODE_ALIASES).
    ERROR_CODE_ALIASES = {
      "ABORT_ERROR" => "TIMEOUT",
      "BAD_REQUEST" => "INVALID_REQUEST",
      "CONNECTION_ERROR" => "WALLET_UNAVAILABLE",
      "EXPIRED" => "INVOICE_EXPIRED",
      "FETCH_ERROR" => "WALLET_UNAVAILABLE",
      "FORBIDDEN" => "RESTRICTED",
      "INVOICE_NOT_FOUND" => "NOT_FOUND",
      "INVALID_PARAMETER" => "INVALID_REQUEST",
      "INVALID_PARAMETERS" => "INVALID_REQUEST",
      "INVALID_PARAMS" => "INVALID_REQUEST",
      "METHOD_NOT_FOUND" => "UNSUPPORTED_METHOD",
      "NETWORK_ERROR" => "WALLET_UNAVAILABLE",
      "NIP47_NETWORK_ERROR" => "WALLET_UNAVAILABLE",
      "NOSTR_NETWORK_ERROR" => "WALLET_UNAVAILABLE",
      "NOT_AUTHORIZED" => "UNAUTHORIZED",
      "NOT_SUPPORTED" => "UNSUPPORTED_METHOD",
      "NOTFOUND" => "NOT_FOUND",
      "PERMISSION_DENIED" => "RESTRICTED",
      "RELAY_CONNECTION_ERROR" => "WALLET_UNAVAILABLE",
      "REQUEST_TIMEOUT" => "TIMEOUT",
      "SERVICE_UNAVAILABLE" => "WALLET_UNAVAILABLE",
      "TIMED_OUT" => "TIMEOUT",
      "TIMEOUT_ERROR" => "TIMEOUT",
      "UNKNOWN_METHOD" => "UNSUPPORTED_METHOD",
      "UNSUPPORTED" => "UNSUPPORTED_METHOD",
      "UNSUPPORTED_ENCRYPTION_MODE" => "UNSUPPORTED_ENCRYPTION",
      "WALLET_OFFLINE" => "WALLET_UNAVAILABLE",
      "WALLET_UNREACHABLE" => "WALLET_UNAVAILABLE"
    }.freeze
    ERROR_MESSAGES = {
      "NOT_IMPLEMENTED" => "NWC wallet service does not implement this method.",
      "RESTRICTED" => "NWC wallet service restricted this request.",
      "UNAUTHORIZED" => "NWC wallet service rejected authorization.",
      "RATE_LIMITED" => "NWC wallet service rate limited this request.",
      "QUOTA_EXCEEDED" => "NWC wallet service quota was exceeded.",
      "INTERNAL" => "NWC wallet service returned an internal error.",
      "UNSUPPORTED_ENCRYPTION" => "NWC wallet service does not support the required encryption mode.",
      "INSUFFICIENT_BALANCE" => "NWC wallet reported insufficient balance.",
      "PAYMENT_FAILED" => "NWC wallet reported payment failure.",
      "OTHER" => "NWC wallet service returned an unknown error.",
      "NOT_FOUND" => "NWC wallet service could not find the requested resource.",
      "TIMEOUT" => "NWC wallet service request timed out.",
      "INVALID_REQUEST" => "OpenReceive sent an invalid NWC wallet request.",
      "WALLET_UNAVAILABLE" => "NWC wallet service is unavailable.",
      "INVOICE_EXPIRED" => "NWC wallet reported that the invoice is expired.",
      "UNSUPPORTED_METHOD" => "NWC wallet service does not support the requested method.",
      "CONFLICT" => "NWC wallet service reported a conflicting request."
    }.freeze

    # Normalize any wallet/library failure into the canonical error body shape
    # shared with JS (spec/test-vectors/error-normalization.json):
    # { "code", "message", "retryable", "request_id"?, "details"? }.
    def normalize_wallet_error(raw)
      records = collect_error_records(raw)
      code = error_code_from_records(records) ||
             (raw.is_a?(String) ? normalize_error_code(raw) : nil) ||
             "OTHER"
      {
        "code" => code,
        "message" => error_message_from(records, raw, code),
        "retryable" => first_boolean(records, "retryable") { RETRYABLE_ERROR_CODES.include?(code) },
        "request_id" => first_string(records, %w[request_id requestId]),
        "details" => records.filter_map { |record| record["details"] if record["details"].is_a?(Hash) }.first
      }.compact
    end

    def normalize_error_code(value)
      return nil unless value.is_a?(String) && !value.strip.empty?
      normalized = value.strip
                        .gsub(/([a-z0-9])([A-Z])/, '\1_\2')
                        .gsub(/[^a-zA-Z0-9]+/, "_")
                        .gsub(/\A_+|_+\z/, "")
                        .upcase
      return normalized if ERROR_CODES.include?(normalized)
      ERROR_CODE_ALIASES[normalized]
    end

    def error_code_from_records(records)
      records.each do |record|
        direct = %w[code error_code errorCode type].filter_map { |key| normalize_error_code(record[key]) }.first
        return direct if direct && direct != "OTHER"
        name = normalize_error_code(record["name"])
        return name if name && name != "OTHER"
        return direct unless direct.nil?
      end
      nil
    end

    def error_message_from(records, raw, code)
      message = first_string(records, %w[message description reason])
      return message if message && normalize_error_code(message) != code
      if raw.is_a?(String) && normalize_error_code(raw).nil? && !raw.strip.empty?
        return raw.strip
      end
      ERROR_MESSAGES.fetch(code)
    end

    def collect_error_records(value, seen = [])
      return [] if value.nil? || seen.include?(value.object_id)
      seen << value.object_id
      records = []
      if value.is_a?(Exception)
        record = { "name" => value.class.name.split("::").last, "message" => value.message }
        record["code"] = value.code if value.respond_to?(:code)
        records << record
        records.concat(collect_error_records(value.cause, seen)) if value.cause
      elsif value.respond_to?(:each_pair)
        record = value.each_pair.to_h { |key, item| [key.to_s, item] }
        records << record
        %w[error cause data].each do |key|
          records.concat(collect_error_records(record[key], seen)) if record[key]
        end
      end
      records
    end

    def first_string(records, keys)
      records.each do |record|
        keys.each do |key|
          value = record[key]
          return value if value.is_a?(String) && !value.empty?
        end
      end
      nil
    end

    def first_boolean(records, key)
      records.each do |record|
        value = record[key]
        return value if value == true || value == false
      end
      yield
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
require_relative "openreceive/rates"
require_relative "openreceive/swap_address"
