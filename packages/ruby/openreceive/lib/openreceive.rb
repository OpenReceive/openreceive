# frozen_string_literal: true

require "bigdecimal"
require "digest"
require "json"
require "uri"

module OpenReceive
  VERSION = "0.1.0"
  NWC_CODE_HELP_URL = "https://openreceive.org/get_a_nwc_code_to_receive_payments"
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

    def list_transactions(_request)
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

    def settled?(transaction)
      data = stringify_keys(transaction)
      present?(data["settled_at"]) ||
        data["state"] == "settled" ||
        data["transaction_state"] == "settled"
    end

    def expired?(transaction)
      data = stringify_keys(transaction)
      data["state"] == "expired" || data["transaction_state"] == "expired"
    end

    def failed?(transaction)
      data = stringify_keys(transaction)
      data["state"] == "failed" || data["transaction_state"] == "failed"
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

    def list_transactions_request(request)
      data = stringify_keys(request)
      result = {}
      %w[from until offset].each do |key|
        next unless data.key?(key)

        value = integer(data[key])
        raise ArgumentError, "#{key} must be non-negative" if value.negative?

        result[key] = value
      end
      if data.key?("limit")
        limit = integer(data["limit"])
        raise ArgumentError, "limit must be positive" unless limit.positive?

        result["limit"] = limit
      end
      if data.key?("unpaid")
        unpaid = data["unpaid"]
        raise ArgumentError, "unpaid must be true or false" unless unpaid == true || unpaid == false

        result["unpaid"] = unpaid
      end
      if data.key?("type")
        type = data["type"].to_s
        raise ArgumentError, "type must be incoming or outgoing" unless %w[incoming outgoing].include?(type)

        result["type"] = type
      end
      if result.key?("from") && result.key?("until") && result["from"] > result["until"]
        raise ArgumentError, "from must be less than or equal to until"
      end
      result
    end

    def normalize_list_transactions_response(response)
      data = stringify_keys(response)
      raw_transactions = data["transactions"] || data.dig("result", "transactions") || (response.is_a?(Array) ? response : [])
      { "transactions" => Array(raw_transactions).map { |transaction| normalize_transaction(transaction) } }
    end

    def normalize_transaction(transaction)
      data = stringify_keys(transaction)
      transaction_state = data["transaction_state"] || data["transactionState"] || data["state"]
      {
        "type" => normalize_type(data["type"]),
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

    def normalize_type(value)
      text = value.to_s.downcase
      %w[incoming outgoing].include?(text) ? text : nil
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

  module Idempotency
    module_function

    def scope_key(namespace:, operation:, idempotency_key:)
      [
        encode_scope_segment(namespace),
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

  class InMemoryInvoiceKvStore
    TRANSACTION_STATES = %w[pending settled expired failed accepted].freeze
    WORKFLOW_STATES = %w[
      draft
      invoice_created
      verifying
      settlement_action_pending
      settlement_action_completed
      expiry_pending_verification
      expired_closed
      failed_closed
      cancelled
    ].freeze
    SETTLEMENT_ACTION_STATES = %w[pending completed failed].freeze

    def initialize
      @by_invoice_id = {}
      @by_payment_hash = {}
      @by_bolt11_invoice = {}
      @by_idempotency_scope = {}
      @meta = {}
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

    def find_by_bolt11_invoice(invoice)
      invoice_id = @by_bolt11_invoice[invoice]
      invoice_id.nil? ? nil : find_by_invoice_id(invoice_id)
    end

    def require_stored_invoice(invoice_id)
      row = @by_invoice_id[invoice_id]
      raise InvoiceNotFoundError.new(invoice_id) if row.nil?

      row
    end

    def mark_verifying(invoice_id:)
      row = require_stored_invoice(invoice_id)
      if row["transaction_state"] != "settled" &&
          %w[invoice_created expiry_pending_verification].include?(row["workflow_state"])
        row["workflow_state"] = "verifying"
      end
      deep_copy(row)
    end

    def mark_expiry_pending_verification(invoice_id:)
      row = require_stored_invoice(invoice_id)
      unless %w[settled expired failed].include?(row["transaction_state"])
        row["workflow_state"] = "expiry_pending_verification"
      end
      deep_copy(row)
    end

    def mark_settled(invoice_id:, settled_at:)
      row = require_stored_invoice(invoice_id)
      row["transaction_state"] = "settled"
      row["workflow_state"] = "settlement_action_pending" unless row["workflow_state"] == "settlement_action_completed"
      row["settled_at"] ||= integer(settled_at)
      deep_copy(row)
    end

    def mark_expired_closed(invoice_id:)
      row = require_stored_invoice(invoice_id)
      if row["transaction_state"] != "settled"
        row["transaction_state"] = "expired"
        row["workflow_state"] = "expired_closed"
      end
      deep_copy(row)
    end

    def mark_failed_closed(invoice_id:)
      row = require_stored_invoice(invoice_id)
      if row["transaction_state"] != "settled"
        row["transaction_state"] = "failed"
        row["workflow_state"] = "failed_closed"
      end
      deep_copy(row)
    end

    def mark_settlement_action_completed(invoice_id:, settlement_action_completed_at:)
      row = require_stored_invoice(invoice_id)
      row["workflow_state"] = "settlement_action_completed"
      row["settlement_action_state"] = "completed"
      row["settlement_action_completed_at"] ||= integer(settlement_action_completed_at)
      deep_copy(row)
    end

    def mark_settlement_action_failed(invoice_id:)
      row = require_stored_invoice(invoice_id)
      row["workflow_state"] = "settlement_action_pending"
      row["settlement_action_state"] = "failed"
      deep_copy(row)
    end

    def get_meta(key)
      row = @meta[key]
      row.nil? ? nil : deep_copy(row)
    end

    def cas_meta(key:, value:, expected_rev:)
      raise ArgumentError, "meta key must be a non-empty string" unless key.is_a?(String) && !key.empty?

      current = @meta[key]
      if expected_rev.nil?
        unless current.nil?
          return { "status" => "conflict", "row" => deep_copy(current) }
        end

        row = { "value" => value, "rev" => 0 }
        @meta[key] = row
        return { "status" => "ok", "row" => deep_copy(row) }
      end

      if current.nil? || current.fetch("rev") != Integer(expected_rev)
        return {
          "status" => "conflict",
          "row" => current.nil? ? { "value" => "", "rev" => -1 } : deep_copy(current)
        }
      end

      row = { "value" => value, "rev" => Integer(expected_rev) + 1 }
      @meta[key] = row
      { "status" => "ok", "row" => deep_copy(row) }
    end

    private

    def scope_key(scope)
      data = stringify_keys(scope)
      Idempotency.scope_key(
        namespace: data.fetch("namespace"),
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
        namespace
        operation
        idempotency_key
      ].each { |key| assert_non_empty_string(row.fetch(key), key) }

      assert_member(row.fetch("transaction_state"), TRANSACTION_STATES, "transaction_state")
      assert_member(row.fetch("workflow_state"), WORKFLOW_STATES, "workflow_state")
      assert_member(row.fetch("settlement_action_state"), SETTLEMENT_ACTION_STATES, "settlement_action_state")
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

  def missing_nwc_message(subject: "OpenReceive")
    [
      "#{subject} needs a receive-only NWC code to receive payments.",
      "Set OPENRECEIVE_NWC to your receive-only Nostr Wallet Connect connection string.",
      "Get one here: #{NWC_CODE_HELP_URL}"
    ].join("\n")
  end

  def invalid_nwc_message(reason: nil)
    [
      "OPENRECEIVE_NWC is set, but it is not a valid NWC code.",
      (reason.nil? ? nil : "Reason: #{reason}"),
      "Get a receive-only NWC code here: #{NWC_CODE_HELP_URL}"
    ].compact.join("\n")
  end

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

  def settled?(transaction)
    Settlement.settled?(transaction)
  end

  def expired?(transaction)
    Settlement.expired?(transaction)
  end

  def failed?(transaction)
    Settlement.failed?(transaction)
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

  def idempotency_scope_key(namespace:, operation:, idempotency_key:)
    Idempotency.scope_key(
      namespace: namespace,
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
