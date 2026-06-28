# frozen_string_literal: true

require "json"
require "minitest/autorun"
require "openreceive"

class OpenReceiveTest < Minitest::Test
  ROOT = File.expand_path("../../../..", __dir__)

  def read_vector(relative_path)
    JSON.parse(File.read(File.join(ROOT, relative_path)))
  end

  def invoice_row(overrides = {})
    {
      "invoice_id" => "or_inv_test_1",
      "namespace" => "demo:tenant:alpha",
      "operation" => "invoice.create",
      "idempotency_key" => "fruit-demo-user-123-order-456",
      "idempotency_request_hash" => "sha256:#{"a" * 64}",
      "payment_hash" => "b" * 64,
      "invoice" => "lnbc-ruby-store",
      "amount_msats" => 200_000,
      "transaction_state" => "pending",
      "workflow_state" => "invoice_created",
      "settlement_action_state" => "pending",
      "created_at" => 1000,
      "expires_at" => 1600,
      "metadata" => {}
    }.merge(overrides)
  end

  class FakeNwcRubyClient
    attr_reader :make_invoice_calls, :list_transactions_calls

    def initialize
      @make_invoice_calls = []
      @list_transactions_calls = []
    end

    def make_invoice(params)
      params.fetch("amount")
      @make_invoice_calls << params
      {
        "invoice" => "lnbc-ruby-nwc",
        "payment_hash" => "c" * 64,
        "amount" => params.fetch("amount"),
        "created_at" => 1000,
        "expires_at" => 1600
      }
    end

    def list_transactions(params)
      params.fetch("type")
      @list_transactions_calls << params
      {
        "transactions" => [{
          "type" => "incoming",
          "invoice" => "lnbc-ruby-nwc",
          "payment_hash" => "c" * 64,
          "amount" => 200_000,
          "state" => "settled",
          "settled_at" => 1200
        }]
      }
    end

    def pay_invoice(_params)
      raise "spend method should not be called"
    end
  end

  class FakeKeywordNwcRubyClient
    attr_reader :make_invoice_calls, :list_transactions_calls

    def initialize
      @make_invoice_calls = []
      @list_transactions_calls = []
    end

    def make_invoice(amount:, description: nil, **_extra)
      @make_invoice_calls << { amount: amount, description: description }
      {
        "invoice" => "lnbc-ruby-keyword",
        "payment_hash" => "d" * 64,
        "amount" => amount,
        "created_at" => 1000,
        "expires_at" => 1600
      }
    end

    def list_transactions(**params)
      @list_transactions_calls << params
      {
        "transactions" => [{
          "type" => "incoming",
          "invoice" => "lnbc-ruby-keyword",
          "payment_hash" => "d" * 64,
          "amount" => 200_000,
          "state" => "settled",
          "settled_at" => 1200
        }]
      }
    end
  end

  def test_quotes_fiat_to_msats_from_shared_vectors
    vector = read_vector("spec/test-vectors/fiat-to-msats.usd.json")

    vector.fetch("cases").each do |item|
      sats = OpenReceive.quote_fiat_to_sats(
        fiat_value: item.fetch("fiat").fetch("value"),
        btc_fiat_price: vector.fetch("btc_fiat_price")
      )
      msats = OpenReceive.quote_fiat_to_msats(
        fiat_value: item.fetch("fiat").fetch("value"),
        btc_fiat_price: vector.fetch("btc_fiat_price")
      )

      assert_equal item.fetch("expected").fetch("amount_sats"), sats, item.fetch("name")
      assert_equal item.fetch("expected").fetch("amount_msats"), msats, item.fetch("name")
      assert_operator msats, :>=, 1000
    end
  end

  def test_rejects_binary_float_style_money_inputs
    assert_raises(ArgumentError) do
      OpenReceive.quote_fiat_to_msats(fiat_value: "1e-2", btc_fiat_price: "42000")
    end

    assert_raises(ArgumentError) do
      OpenReceive.quote_fiat_to_msats(fiat_value: "0.01", btc_fiat_price: "0")
    end
  end

  def test_detects_settlement_from_shared_vectors
    vector = read_vector("spec/test-vectors/settlement-detection.json")

    vector.fetch("cases").each do |item|
      assert_equal(
        item.fetch("expected").fetch("settled"),
        OpenReceive.settled?(item.fetch("transaction")),
        item.fetch("name")
      )
    end
  end

  def test_preimage_alone_is_not_settlement
    refute OpenReceive.settled?("preimage" => "abc123")
  end

  def test_parses_and_redacts_nwc_uri_from_shared_vectors
    vector = read_vector("spec/test-vectors/nwc-uri-parse.json")

    vector.fetch("cases").each do |item|
      if item["expected_error"]
        error = assert_raises(OpenReceive::NwcUriParseError, item.fetch("name")) do
          OpenReceive.parse_nwc_uri(item.fetch("uri"))
        end
        assert_equal item.fetch("expected_error"), error.code
        refute_includes error.redacted.to_s, "secret=#{item.fetch("uri")[/secret=([^&]+)/, 1]}"
        next
      end

      parsed = OpenReceive.parse_nwc_uri(item.fetch("uri"))
      expected = item.fetch("expected")

      assert_equal expected.fetch("wallet_pubkey"), parsed.fetch(:wallet_pubkey), item.fetch("name")
      assert_equal expected.fetch("relays"), parsed.fetch(:relays), item.fetch("name")
      if expected.fetch("lud16").nil?
        assert_nil parsed.fetch(:lud16), item.fetch("name")
      else
        assert_equal expected.fetch("lud16"), parsed.fetch(:lud16), item.fetch("name")
      end
      assert_equal expected.fetch("redacted"), parsed.fetch(:redacted), item.fetch("name")
      assert_equal expected.fetch("redacted"), OpenReceive.redact_nwc_uri(item.fetch("uri")), item.fetch("name")
      assert expected.fetch("secret_present")
      refute_includes parsed.fetch(:redacted), parsed.fetch(:client_secret)
    end
  end

  def test_maps_receive_nwc_requests_and_responses_from_shared_vectors
    vector = read_vector("spec/test-vectors/nwc-request-response.json")

    vector.fetch("cases").each do |item|
      if item.fetch("method") == "make_invoice"
        assert_equal(
          item.fetch("expected_nip47_request"),
          OpenReceive.make_invoice_nip47_request(item.fetch("openreceive_request")),
          item.fetch("name")
        )
        assert_equal(
          item.fetch("expected_openreceive_response"),
          OpenReceive.normalize_make_invoice_response(item.fetch("raw_response")),
          item.fetch("name")
        )
      else
        assert_equal(
          item.fetch("expected_nip47_request"),
          OpenReceive.list_transactions_nip47_request(item.fetch("openreceive_request")),
          item.fetch("name")
        )
        assert_equal(
          item.fetch("expected_openreceive_response"),
          OpenReceive.normalize_list_transactions_response(item.fetch("raw_response")),
          item.fetch("name")
        )
      end
    end
  end

  def test_make_invoice_validation_vectors
    vector = read_vector("spec/test-vectors/make-invoice-validation.json")

    vector.fetch("cases").each do |item|
      request = item.fetch("request").dup
      if request.key?("metadata_note_length")
        request.delete("metadata_note_length")
        request["metadata"] = { "note" => "x" * item.fetch("request").fetch("metadata_note_length") }
      end

      if item.fetch("expected").fetch("valid")
        assert_kind_of Hash, OpenReceive.make_invoice_nip47_request(request), item.fetch("name")
      else
        assert_raises(ArgumentError, item.fetch("name")) do
          OpenReceive.make_invoice_nip47_request(request)
        end
      end
    end
  end

  def test_make_invoice_rejects_amount_boundary_vectors_before_wallet_mapping
    vector = read_vector("spec/test-vectors/amount-boundaries.json")

    vector.fetch("cases").each do |item|
      request = { "amount_msats" => item.fetch("amount_msats"), "description" => "Fruit sticker" }
      if item.fetch("valid")
        assert_kind_of Hash, OpenReceive.make_invoice_nip47_request(request), item.fetch("name")
      else
        assert_raises(ArgumentError, item.fetch("name")) do
          OpenReceive.make_invoice_nip47_request(request)
        end
      end
    end
  end

  def test_nwc_ruby_receive_client_wraps_receive_methods_only
    uri =
      "nostr+walletconnect://#{"a" * 64}" \
      "?relay=wss%3A%2F%2Frelay.example.com&secret=#{"b" * 64}"
    raw_client = FakeNwcRubyClient.new
    client = OpenReceive::NwcRubyReceiveClient.new(client: raw_client, connection_uri: uri)

    invoice = client.make_invoice(
      "amount_msats" => 200_000,
      "description" => "Fruit sticker"
    )
    transactions = client.list_transactions(
      "type" => "incoming",
      "unpaid" => true,
      "from" => 1000,
      "until" => 1000,
      "limit" => 20,
      "offset" => 0
    )
    transaction = transactions.fetch("transactions").first

    assert_equal "lnbc-ruby-nwc", invoice.fetch("invoice")
    assert_equal 200_000, invoice.fetch("amount_msats")
    assert_equal "settled", transaction.fetch("transaction_state")
    assert_equal [{ "amount" => 200_000, "description" => "Fruit sticker" }], raw_client.make_invoice_calls
    assert_equal [{ "type" => "incoming", "unpaid" => true, "from" => 1000, "until" => 1000, "limit" => 20, "offset" => 0 }], raw_client.list_transactions_calls
    refute client.respond_to?(:pay_invoice)
    assert_includes client.redacted_connection_uri, "secret=[REDACTED]"
    refute_includes client.redacted_connection_uri, "b" * 64
  end

  def test_nwc_ruby_receive_client_prefers_documented_keyword_methods
    raw_client = FakeKeywordNwcRubyClient.new
    client = OpenReceive::NwcRubyReceiveClient.new(client: raw_client)

    invoice = client.make_invoice(
      "amount_msats" => 200_000,
      "description" => "Fruit sticker"
    )
    transactions = client.list_transactions(
      "type" => "incoming",
      "unpaid" => true,
      "from" => 1000,
      "until" => 1000,
      "limit" => 20,
      "offset" => 0
    )
    transaction = transactions.fetch("transactions").first

    assert_equal "lnbc-ruby-keyword", invoice.fetch("invoice")
    assert_equal "settled", transaction.fetch("transaction_state")
    assert_equal [{ amount: 200_000, description: "Fruit sticker" }], raw_client.make_invoice_calls
    assert_equal [{ type: "incoming", unpaid: true, from: 1000, until: 1000, limit: 20, offset: 0 }], raw_client.list_transactions_calls
  end

  def test_unavailable_receive_client_fails_closed_without_wallet_methods
    client = OpenReceive::UnavailableReceiveClient.new(
      message: OpenReceive.missing_nwc_message
    )

    error = assert_raises(OpenReceive::WalletUnavailableError) do
      client.make_invoice("amount_msats" => 200_000)
    end
    transaction_error = assert_raises(OpenReceive::WalletUnavailableError) do
      client.list_transactions("type" => "incoming")
    end

    assert_equal 503, error.status
    assert_equal "WALLET_UNAVAILABLE", error.code
    assert_includes error.message, "needs a receive-only NWC code to receive payments"
    assert_includes error.message, "https://openreceive.org/get_a_nwc_code_to_receive_payments"
    assert_equal "WALLET_UNAVAILABLE", transaction_error.code
    assert_equal({ "wallet_configured" => false }, client.get_info)
    refute client.respond_to?(:pay_invoice)
  end

  def test_nwc_boot_messages_include_help_url
    assert_includes OpenReceive.missing_nwc_message(subject: "Demo"), "Demo needs a receive-only NWC code"
    assert_includes OpenReceive.missing_nwc_message, "https://openreceive.org/get_a_nwc_code_to_receive_payments"
    assert_includes OpenReceive.invalid_nwc_message(reason: "bad scheme"), "bad scheme"
    assert_includes OpenReceive.invalid_nwc_message, "https://openreceive.org/get_a_nwc_code_to_receive_payments"
  end

  def test_idempotency_vectors
    vector = read_vector("spec/test-vectors/idempotency.json")
    assert_equal "namespace+operation+idempotency_key", vector.fetch("canonical_scope").join("+")

    vector.fetch("cases").each do |item|
      key = OpenReceive.idempotency_scope_key(
        namespace: item.fetch("namespace"),
        operation: item.fetch("operation"),
        idempotency_key: item.fetch("idempotency_key")
      )
      assert_includes key, item.fetch("operation")

      classified = OpenReceive.classify_idempotency(
        first_request_hash: item.fetch("first_request_hash"),
        second_request_hash: item.fetch("second_request_hash"),
        operation: item.fetch("operation")
      )
      assert_equal item.fetch("expected").fetch("status"), classified.fetch("status"), item.fetch("name")
      assert_equal item.fetch("expected")["behavior"], classified["behavior"], item.fetch("name") if item.fetch("expected").key?("behavior")
      assert_equal item.fetch("expected")["error_code"], classified["error_code"], item.fetch("name") if item.fetch("expected").key?("error_code")
    end
  end

  def test_in_memory_invoice_store_replays_idempotent_creates
    store = OpenReceive::InMemoryInvoiceKvStore.new
    created = store.create_invoice(invoice_row)
    replayed = store.create_invoice(invoice_row)

    assert_equal "created", created.fetch("status")
    assert_equal "replayed", replayed.fetch("status")
    assert_equal created.fetch("row"), replayed.fetch("row")
    assert_equal created.fetch("row"), store.find_by_payment_hash("b" * 64)
  end

  def test_in_memory_invoice_store_rejects_idempotency_drift
    store = OpenReceive::InMemoryInvoiceKvStore.new
    store.create_invoice(invoice_row)

    error = assert_raises(OpenReceive::IdempotencyConflictError) do
      store.create_invoice(invoice_row("idempotency_request_hash" => "sha256:#{"c" * 64}"))
    end

    assert_equal 409, error.status
    assert_equal "CONFLICT", error.code
  end

  def test_in_memory_invoice_store_rejects_duplicate_payment_hash
    store = OpenReceive::InMemoryInvoiceKvStore.new
    store.create_invoice(invoice_row)

    assert_raises(OpenReceive::InvoiceStorageConflictError) do
      store.create_invoice(
        invoice_row(
          "invoice_id" => "or_inv_test_2",
          "idempotency_key" => "fruit-demo-user-123-order-789",
          "idempotency_request_hash" => "sha256:#{"d" * 64}",
          "invoice" => "lnbc-ruby-store-2"
        )
      )
    end
  end

  def test_in_memory_invoice_store_settlement_action_is_duplicate_safe
    store = OpenReceive::InMemoryInvoiceKvStore.new
    store.create_invoice(invoice_row)

    first_settle = store.mark_settled(invoice_id: "or_inv_test_1", settled_at: 1200)
    second_settle = store.mark_settled(invoice_id: "or_inv_test_1", settled_at: 1300)
    completed = store.mark_settlement_action_completed(invoice_id: "or_inv_test_1", settlement_action_completed_at: 1400)
    completed_again = store.mark_settlement_action_completed(invoice_id: "or_inv_test_1", settlement_action_completed_at: 1500)

    assert_equal "settled", first_settle.fetch("transaction_state")
    assert_equal "settlement_action_pending", first_settle.fetch("workflow_state")
    assert_equal 1200, second_settle.fetch("settled_at")
    assert_equal "settlement_action_completed", completed.fetch("workflow_state")
    assert_equal "completed", completed.fetch("settlement_action_state")
    assert_equal 1400, completed_again.fetch("settlement_action_completed_at")

    settled_after_action = store.mark_settled(invoice_id: "or_inv_test_1", settled_at: 1600)
    assert_equal "settlement_action_completed", settled_after_action.fetch("workflow_state")
    assert_equal "completed", settled_after_action.fetch("settlement_action_state")
    assert_equal 1200, settled_after_action.fetch("settled_at")
  end

end
