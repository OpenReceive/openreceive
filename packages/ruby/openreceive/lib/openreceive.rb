# frozen_string_literal: true

require "bigdecimal"
require "digest"
require "json"
require "uri"

module OpenReceive
  VERSION = "0.1.0"
  NWC_METADATA_MAX_BYTES = 3900
  MIN_AMOUNT_MSATS = 1000
  MAX_AMOUNT_MSATS = 9_007_199_254_740_991
  DECIMAL_PATTERN = /\A[0-9]+(?:\.[0-9]+)?\z/.freeze
  HEX_64_PATTERN = /\A[0-9a-fA-F]{64}\z/.freeze

  class NwcUriParseError < StandardError
    attr_reader :code, :redacted

    def initialize(code, message, uri = nil)
      super(message)
      @code = code
      @redacted = uri.nil? ? nil : Nwc.redact_uri(uri)
    end
  end

  class IdempotencyConflictError < StandardError
    attr_reader :status, :code, :scope

    def initialize(scope)
      super("Idempotency key was reused with a different request body.")
      @status = 409
      @code = "CONFLICT"
      @scope = scope
    end
  end

  class InvoiceStorageConflictError < StandardError
    attr_reader :status, :code

    def initialize(message)
      super(message)
      @status = 409
      @code = "CONFLICT"
    end
  end

  class InvoiceNotFoundError < StandardError
    attr_reader :status, :code

    def initialize(invoice_id)
      super("Invoice not found: #{invoice_id}")
      @status = 404
      @code = "NOT_FOUND"
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

  class UnavailableReceiveClient
    def initialize(message: "NWC wallet service is unavailable.")
      @message = message
    end

    def make_invoice(_request)
      raise WalletUnavailableError.new(@message)
    end

    def lookup_invoice(_request)
      raise WalletUnavailableError.new(@message)
    end

    def get_info
      {
        "wallet_configured" => false
      }
    end
  end

  module Money
    module_function

    def quote_fiat_to_sats(fiat_value:, btc_fiat_price:)
      fiat = parse_decimal(fiat_value)
      price = parse_decimal(btc_fiat_price)
      raise ArgumentError, "btc_fiat_price must be greater than zero" unless price.positive?

      ((fiat * 100_000_000) / price).ceil
    end

    def quote_fiat_to_msats(fiat_value:, btc_fiat_price:)
      quote_fiat_to_sats(
        fiat_value: fiat_value,
        btc_fiat_price: btc_fiat_price
      ) * 1000
    end

    def parse_decimal(value)
      text = value.to_s
      raise ArgumentError, "invalid decimal" unless DECIMAL_PATTERN.match?(text)

      BigDecimal(text)
    end
  end

  module Settlement
    module_function

    def settled?(lookup_invoice)
      data = stringify_keys(lookup_invoice)
      present?(data["settled_at"]) ||
        data["state"] == "settled" ||
        data["transaction_state"] == "settled"
    end

    def stringify_keys(value)
      return {} unless value.respond_to?(:each_pair)

      value.each_pair.each_with_object({}) do |(key, item), result|
        result[key.to_s] = item
      end
    end

    def present?(value)
      !value.nil? && value != ""
    end
  end

  module Nwc
    module_function

    def make_invoice_request(request)
      data = stringify_keys(request)
      if present?(data["description"]) && present?(data["description_hash"])
        raise ArgumentError, "description and description_hash cannot both be set"
      end
      if data.key?("description_hash") && !HEX_64_PATTERN.match?(data["description_hash"].to_s)
        raise ArgumentError, "description_hash must be 64 hex characters"
      end

      amount_msats = integer(data.fetch("amount_msats"))
      unless amount_msats >= MIN_AMOUNT_MSATS && amount_msats <= MAX_AMOUNT_MSATS
        raise ArgumentError, "amount_msats must be within v0.1 safe integer bounds"
      end

      params = { "amount" => amount_msats }
      params["description"] = data["description"] if data.key?("description")
      params["description_hash"] = data["description_hash"] if data.key?("description_hash")
      params["expiry"] = integer(data["expiry"]) if data.key?("expiry")
      if data.key?("metadata")
        metadata_json = JSON.generate(data["metadata"])
        if metadata_json.bytesize > NWC_METADATA_MAX_BYTES
          raise ArgumentError, "metadata must serialize below #{NWC_METADATA_MAX_BYTES} bytes"
        end
        params["metadata"] = data["metadata"]
      end
      params
    end

    def normalize_make_invoice_response(response)
      data = stringify_keys(response)
      {
        "invoice" => data["invoice"],
        "payment_hash" => data["payment_hash"] || data["paymentHash"],
        "amount_msats" => integer(data["amount_msats"] || data["amount"]),
        "created_at" => optional_integer(data["created_at"] || data["createdAt"]),
        "expires_at" => optional_integer(data["expires_at"] || data["expiresAt"])
      }.reject { |_key, value| value.nil? }
    end

    def lookup_invoice_request(request)
      data = stringify_keys(request)
      has_payment_hash = present?(data["payment_hash"])
      has_invoice = present?(data["invoice"])
      raise ArgumentError, "lookup_invoice needs exactly one selector" if has_payment_hash == has_invoice

      has_payment_hash ? { "payment_hash" => data["payment_hash"] } : { "invoice" => data["invoice"] }
    end

    def normalize_lookup_invoice_response(response)
      data = stringify_keys(response)
      transaction_state = data["transaction_state"] || data["transactionState"] || data["state"]
      {
        "invoice" => data["invoice"],
        "payment_hash" => data["payment_hash"] || data["paymentHash"],
        "amount_msats" => optional_integer(data["amount_msats"] || data["amount"]),
        "transaction_state" => transaction_state&.downcase,
        "created_at" => optional_integer(data["created_at"] || data["createdAt"]),
        "expires_at" => optional_integer(data["expires_at"] || data["expiresAt"]),
        "settled_at" => optional_integer(data["settled_at"] || data["settledAt"]),
        "preimage" => data["preimage"]
      }.reject { |_key, value| value.nil? }
    end

    def parse_uri(uri)
      parsed = parse_uri_object(uri)
      raise NwcUriParseError.new("invalid_scheme", "NWC URI must use nostr+walletconnect.", uri) unless parsed.scheme == "nostr+walletconnect"

      wallet_pubkey = parsed.host.to_s.empty? ? parsed.path.to_s.sub(%r{\A/+}, "") : parsed.host
      raise NwcUriParseError.new("missing_wallet_pubkey", "NWC URI is missing the wallet public key.", uri) if wallet_pubkey.empty?
      raise NwcUriParseError.new("invalid_wallet_pubkey", "NWC wallet public key must be 64 hex characters.", uri) unless HEX_64_PATTERN.match?(wallet_pubkey)

      pairs = query_pairs(parsed.query)
      relays = pairs.select { |key, _value| key == "relay" }.map { |_key, value| value }
      raise NwcUriParseError.new("missing_relay", "NWC URI must include at least one relay.", uri) if relays.empty?
      unless relays.all? { |relay| valid_relay?(relay) }
        raise NwcUriParseError.new("invalid_relay", "NWC relay URLs must be valid wss URLs.", uri)
      end

      secrets = pairs.select { |key, _value| key == "secret" }.map { |_key, value| value }
      if secrets.empty? || secrets.first.to_s.empty?
        raise NwcUriParseError.new("missing_secret", "NWC URI is missing the client secret.", uri)
      end
      unless secrets.length == 1 && HEX_64_PATTERN.match?(secrets.first)
        raise NwcUriParseError.new("invalid_secret", "NWC client secret must be 64 hex characters.", uri)
      end

      lud16 = pairs.find { |key, _value| key == "lud16" }&.last

      {
        wallet_pubkey: wallet_pubkey,
        relays: relays,
        client_secret: secrets.first,
        lud16: lud16,
        redacted: redact_uri(uri)
      }
    end

    def redact_uri(uri)
      query_start = uri.index("?")
      return uri if query_start.nil?

      fragment_start = uri.index("#", query_start + 1)
      query_end = fragment_start || uri.length
      before_query = uri[0..query_start]
      query = uri[(query_start + 1)...query_end]
      after_query = uri[query_end..-1].to_s

      before_query + redact_query(query) + after_query
    end

    def parse_uri_object(uri)
      URI.parse(uri)
    rescue URI::InvalidURIError
      raise NwcUriParseError.new("invalid_uri", "Invalid NWC URI.", uri)
    end

    def query_pairs(query)
      URI.decode_www_form(query.to_s)
    rescue ArgumentError
      []
    end

    def valid_relay?(relay)
      parsed = URI.parse(relay)
      parsed.scheme == "wss" && !parsed.host.to_s.empty?
    rescue URI::InvalidURIError
      false
    end

    def redact_query(query)
      query.split("&").map do |part|
        separator = part.index("=")
        key = separator.nil? ? part : part[0...separator]
        if secret_query_key?(key)
          "#{key}=[REDACTED]"
        else
          part
        end
      end.join("&")
    end

    def secret_query_key?(key)
      URI.decode_www_form_component(key).downcase == "secret"
    rescue ArgumentError
      key.downcase == "secret"
    end

    def stringify_keys(value)
      return {} unless value.respond_to?(:each_pair)

      value.each_pair.each_with_object({}) do |(key, item), result|
        result[key.to_s] = item
      end
    end

    def integer(value)
      Integer(value)
    rescue ArgumentError, TypeError
      raise ArgumentError, "expected integer"
    end

    def optional_integer(value)
      value.nil? ? nil : integer(value)
    end

    def present?(value)
      !value.nil? && value != ""
    end
  end

  module Polling
    module_function

    CADENCE = [
      { "elapsed_seconds_min" => 0, "elapsed_seconds_max" => 14, "delay_seconds" => 2 },
      { "elapsed_seconds_min" => 15, "elapsed_seconds_max" => 59, "delay_seconds" => 5 },
      { "elapsed_seconds_min" => 60, "elapsed_seconds_max" => 179, "delay_seconds" => 10 },
      { "elapsed_seconds_min" => 180, "elapsed_seconds_max" => 599, "delay_seconds" => 20 }
    ].freeze

    def elapsed_seconds(created_at:, now:)
      [integer(now) - integer(created_at), 0].max
    end

    def delay_seconds(created_at:, now:)
      elapsed = elapsed_seconds(created_at: created_at, now: now)
      band = CADENCE.find do |item|
        elapsed >= item.fetch("elapsed_seconds_min") &&
          elapsed <= item.fetch("elapsed_seconds_max")
      end
      (band || CADENCE.last).fetch("delay_seconds")
    end

    def schedule(created_at:, expires_at:, now:)
      created = integer(created_at)
      expires = integer(expires_at)
      current = integer(now)
      raise ArgumentError, "expires_at must be greater than or equal to created_at" if expires < created

      if current >= expires
        return {
          "action" => "final_lookup",
          "reason" => "final_lookup",
          "next_lookup_at" => current,
          "delay_seconds" => 0
        }
      end

      effective_now = [current, created].max
      delay = delay_seconds(created_at: created, now: effective_now)
      next_lookup_at = effective_now + delay

      if next_lookup_at >= expires
        return {
          "action" => "schedule_final_lookup",
          "reason" => "local_expiry",
          "next_lookup_at" => expires,
          "delay_seconds" => expires - current
        }
      end

      {
        "action" => "schedule_lookup",
        "reason" => "cadence",
        "next_lookup_at" => next_lookup_at,
        "delay_seconds" => next_lookup_at - current
      }
    end

    def grace_lookup_schedule(expires_at:, now:, max_attempts: 3, delay_seconds: 5)
      start_at = [integer(expires_at), integer(now)].max
      attempts = integer(max_attempts)
      delay = integer(delay_seconds)
      (1..attempts).map do |attempt|
        {
          "attempt" => attempt,
          "delay_seconds" => delay,
          "lookup_at" => start_at + delay * attempt
        }
      end
    end

    def integer(value)
      Integer(value)
    rescue ArgumentError, TypeError
      raise ArgumentError, "expected integer seconds"
    end
  end

  module Idempotency
    module_function

    def scope_key(merchant_scope:, operation:, idempotency_key:)
      [
        encode_scope_segment(merchant_scope),
        encode_scope_segment(operation),
        encode_scope_segment(idempotency_key)
      ].join(":")
    end

    def request_hash(request)
      "sha256:#{Digest::SHA256.hexdigest(canonical_json(request))}"
    end

    def classify(first_request_hash:, second_request_hash:, operation:)
      if first_request_hash == second_request_hash
        behavior =
          operation == "invoice.refresh" ? "return_original_refresh_invoice" : "return_original_invoice"
        { "status" => 200, "behavior" => behavior }
      else
        { "status" => 409, "error_code" => "CONFLICT" }
      end
    end

    def canonical_json(value)
      case value
      when NilClass, true, false, Numeric, String
        JSON.generate(value)
      when Array
        "[#{value.map { |item| canonical_json(item) }.join(",")}]"
      when Hash
        entries = value.keys.map(&:to_s).sort.map do |key|
          "#{JSON.generate(key)}:#{canonical_json(value.fetch(key) { value.fetch(key.to_sym) })}"
        end
        "{#{entries.join(",")}}"
      else
        raise TypeError, "canonical_json accepts JSON-compatible values only"
      end
    end

    def encode_scope_segment(value)
      text = value.to_s
      raise ArgumentError, "scope segments must be non-empty" if text.empty?

      URI.encode_www_form_component(text)
    end
  end

  class InMemoryInvoiceStore
    TRANSACTION_STATES = %w[pending settled expired failed accepted].freeze
    WORKFLOW_STATES = %w[
      draft
      invoice_created
      verifying
      awaiting_fulfillment
      fulfilled
      expiry_pending_verification
      expired_closed
      failed_closed
      cancelled
    ].freeze
    FULFILLMENT_STATES = %w[pending ready delivered delivery_failed].freeze

    def initialize
      @by_invoice_id = {}
      @by_payment_hash = {}
      @by_bolt11_invoice = {}
      @by_idempotency_scope = {}
    end

    def check_idempotency(scope:, idempotency_request_hash:)
      invoice_id = @by_idempotency_scope[scope_key(scope)]
      return nil if invoice_id.nil?

      row = require_stored_invoice(invoice_id)
      raise IdempotencyConflictError.new(scope) unless row.fetch("idempotency_request_hash") == idempotency_request_hash

      { "status" => "replayed", "row" => deep_copy(row) }
    end

    def create_invoice(row)
      data = stringify_keys(row)
      validate_invoice_row(data)

      key = scope_key(data)
      existing_invoice_id = @by_idempotency_scope[key]
      unless existing_invoice_id.nil?
        existing = require_stored_invoice(existing_invoice_id)
        unless existing.fetch("idempotency_request_hash") == data.fetch("idempotency_request_hash")
          raise IdempotencyConflictError.new(data)
        end
        return { "status" => "replayed", "row" => deep_copy(existing) }
      end

      raise InvoiceStorageConflictError.new("invoice_id must be unique") if @by_invoice_id.key?(data.fetch("invoice_id"))
      raise InvoiceStorageConflictError.new("payment_hash must be unique") if @by_payment_hash.key?(data.fetch("payment_hash"))
      raise InvoiceStorageConflictError.new("invoice must be unique") if @by_bolt11_invoice.key?(data.fetch("invoice"))

      stored = deep_copy(data)
      @by_invoice_id[stored.fetch("invoice_id")] = stored
      @by_payment_hash[stored.fetch("payment_hash")] = stored.fetch("invoice_id")
      @by_bolt11_invoice[stored.fetch("invoice")] = stored.fetch("invoice_id")
      @by_idempotency_scope[key] = stored.fetch("invoice_id")
      { "status" => "created", "row" => deep_copy(stored) }
    end

    def find_by_invoice_id(invoice_id)
      row = @by_invoice_id[invoice_id]
      row.nil? ? nil : deep_copy(row)
    end

    def find_by_payment_hash(payment_hash)
      invoice_id = @by_payment_hash[payment_hash]
      invoice_id.nil? ? nil : find_by_invoice_id(invoice_id)
    end

    def require_stored_invoice(invoice_id)
      row = @by_invoice_id[invoice_id]
      raise InvoiceNotFoundError.new(invoice_id) if row.nil?

      row
    end

    def mark_settled(invoice_id:, settled_at:)
      row = require_stored_invoice(invoice_id)
      row["transaction_state"] = "settled"
      row["workflow_state"] = "awaiting_fulfillment" unless row["workflow_state"] == "fulfilled"
      row["fulfillment_state"] = "ready" unless row["fulfillment_state"] == "delivered"
      row["settled_at"] ||= integer(settled_at)
      deep_copy(row)
    end

    def mark_fulfilled(invoice_id:, fulfilled_at:)
      row = require_stored_invoice(invoice_id)
      row["workflow_state"] = "fulfilled"
      row["fulfillment_state"] = "delivered"
      row["fulfilled_at"] ||= integer(fulfilled_at)
      deep_copy(row)
    end

    private

    def scope_key(scope)
      data = stringify_keys(scope)
      Idempotency.scope_key(
        merchant_scope: data.fetch("merchant_scope"),
        operation: data.fetch("operation"),
        idempotency_key: data.fetch("idempotency_key")
      )
    end

    def validate_invoice_row(row)
      %w[
        invoice_id
        idempotency_request_hash
        payment_hash
        invoice
        merchant_scope
        operation
        idempotency_key
      ].each { |key| assert_non_empty_string(row.fetch(key), key) }

      assert_member(row.fetch("transaction_state"), TRANSACTION_STATES, "transaction_state")
      assert_member(row.fetch("workflow_state"), WORKFLOW_STATES, "workflow_state")
      assert_member(row.fetch("fulfillment_state"), FULFILLMENT_STATES, "fulfillment_state")
      assert_amount_msats(row.fetch("amount_msats"))
      assert_unix_seconds(row.fetch("created_at"), "created_at")
      assert_unix_seconds(row.fetch("expires_at"), "expires_at")
      if integer(row.fetch("expires_at")) < integer(row.fetch("created_at"))
        raise ArgumentError, "expires_at must be greater than or equal to created_at"
      end
      unless /\Asha256:[0-9a-f]{64}\z/.match?(row.fetch("idempotency_request_hash").to_s)
        raise ArgumentError, "idempotency_request_hash must be sha256:<64 hex>"
      end
    end

    def assert_non_empty_string(value, field)
      raise ArgumentError, "#{field} must be a non-empty string" unless value.is_a?(String) && !value.empty?
    end

    def assert_member(value, allowed, field)
      raise ArgumentError, "#{field} is not valid" unless allowed.include?(value)
    end

    def assert_amount_msats(value)
      amount = integer(value)
      unless amount >= MIN_AMOUNT_MSATS && amount <= MAX_AMOUNT_MSATS
        raise ArgumentError, "amount_msats must be within v0.1 safe integer bounds"
      end
    end

    def assert_unix_seconds(value, field)
      raise ArgumentError, "#{field} must be a non-negative integer" if integer(value).negative?
    end

    def integer(value)
      Integer(value)
    rescue ArgumentError, TypeError
      raise ArgumentError, "expected integer"
    end

    def stringify_keys(value)
      value.each_pair.each_with_object({}) do |(key, item), result|
        result[key.to_s] = item
      end
    end

    def deep_copy(value)
      Marshal.load(Marshal.dump(value))
    end
  end

  module_function

  def quote_fiat_to_sats(fiat_value:, btc_fiat_price:)
    Money.quote_fiat_to_sats(
      fiat_value: fiat_value,
      btc_fiat_price: btc_fiat_price
    )
  end

  def quote_fiat_to_msats(fiat_value:, btc_fiat_price:)
    Money.quote_fiat_to_msats(
      fiat_value: fiat_value,
      btc_fiat_price: btc_fiat_price
    )
  end

  def settled?(lookup_invoice)
    Settlement.settled?(lookup_invoice)
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

  def lookup_invoice_nip47_request(request)
    Nwc.lookup_invoice_request(request)
  end

  def normalize_lookup_invoice_response(response)
    Nwc.normalize_lookup_invoice_response(response)
  end

  def polling_delay_seconds(created_at:, now:)
    Polling.delay_seconds(created_at: created_at, now: now)
  end

  def polling_schedule(created_at:, expires_at:, now:)
    Polling.schedule(created_at: created_at, expires_at: expires_at, now: now)
  end

  def idempotency_scope_key(merchant_scope:, operation:, idempotency_key:)
    Idempotency.scope_key(
      merchant_scope: merchant_scope,
      operation: operation,
      idempotency_key: idempotency_key
    )
  end

  def idempotency_request_hash(request)
    Idempotency.request_hash(request)
  end

  def classify_idempotency(first_request_hash:, second_request_hash:, operation:)
    Idempotency.classify(
      first_request_hash: first_request_hash,
      second_request_hash: second_request_hash,
      operation: operation
    )
  end
end

begin
  require_relative "openreceive/nwc_ruby"
rescue LoadError
end
