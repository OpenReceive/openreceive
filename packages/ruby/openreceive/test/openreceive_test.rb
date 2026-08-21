# frozen_string_literal: true

require "minitest/autorun"
require "openreceive"

class OpenReceiveCoreTest < Minitest::Test
  def test_exact_fiat_math_and_settlement_authority
    assert_equal 20_000_000, OpenReceive.quote_fiat_to_msats(
      fiat_value: "10.00",
      btc_fiat_price: "50000.00"
    )
    refute OpenReceive.settled?("preimage" => "f" * 64, "transaction_state" => "pending")
    assert OpenReceive.settled?("transaction_state" => "settled")
  end

  def test_redaction_matches_percent_encoded_secret_keys
    # JS percent-decodes query keys before matching, so %73ecret must redact
    # exactly like a literal secret key.
    uri = "nostr+walletconnect://#{"a" * 64}?relay=wss%3A%2F%2Frelay.example.com&%73ecret=#{"b" * 64}"
    redacted = OpenReceive.redact_nwc_uri(uri)
    refute_includes redacted, "b" * 64
    assert_includes redacted, "%73ecret=[REDACTED]"
    assert_includes redacted, "relay=wss%3A%2F%2Frelay.example.com"
  end

  def test_parse_nwc_uri_accepts_the_opaque_form_without_slashes
    # Wallets also emit `nostr+walletconnect:<pubkey>?...` (no `//`); JS's
    # WHATWG URL parses it, so the Ruby engine must too. A shared
    # nwc-uri-parse vector should pin this once the vector wave lands.
    wallet = "a" * 64
    secret = "b" * 64
    uri = "nostr+walletconnect:#{wallet}?relay=wss%3A%2F%2Frelay.example.com&secret=#{secret}&lud16=pay%40example.com"
    parsed = OpenReceive.parse_nwc_uri(uri)
    assert_equal wallet, parsed.fetch(:wallet_pubkey)
    assert_equal ["wss://relay.example.com"], parsed.fetch(:relays)
    assert_equal secret, parsed.fetch(:client_secret)
    assert_equal "pay@example.com", parsed.fetch(:lud16)
    refute_includes parsed.fetch(:redacted), secret

    error = assert_raises(OpenReceive::NwcUriParseError) do
      OpenReceive.parse_nwc_uri("nostr+walletconnect:#{wallet}")
    end
    assert_equal "missing_relay", error.code
    invalid = assert_raises(OpenReceive::NwcUriParseError) do
      OpenReceive.parse_nwc_uri("nostr+walletconnect:not-hex?relay=wss%3A%2F%2Fr.example&secret=#{secret}")
    end
    assert_equal "invalid_wallet_pubkey", invalid.code
  end

  def test_parse_nwc_uri_rejects_nil_and_empty_as_invalid_uri
    # Parity with JS parseNwcUri: nil/empty input is the invalid_uri parse
    # error, never a bare TypeError.
    [nil, "", "   "].each do |uri|
      error = assert_raises(OpenReceive::NwcUriParseError) { OpenReceive.parse_nwc_uri(uri) }
      assert_equal "invalid_uri", error.code
    end
  end

  def test_nwc_list_limit_maps_through_and_rejects_non_positive
    assert_equal 20, OpenReceive.list_transactions_nip47_request("limit" => 20)["limit"]
    # The mapper passes caller limits through (matches JS and the
    # nwc-request-response vectors); only non-positive limits are invalid.
    assert_equal 25, OpenReceive.list_transactions_nip47_request("limit" => 25)["limit"]
    assert_raises(ArgumentError) { OpenReceive.list_transactions_nip47_request("limit" => 0) }
  end

  def test_settlement_lowercases_raw_wallet_states
    # Parity with JS isTransactionState: raw states compare case-insensitively.
    assert OpenReceive.settled?("state" => "SETTLED")
    refute OpenReceive.settled?("state" => "PENDING")
    assert_equal "expired", OpenReceive::Settlement.status("transaction_state" => "Expired")
    assert_equal "failed", OpenReceive::Settlement.status("state" => "FAILED")
  end

  def test_normalize_transaction_ports_boolean_settlement_and_fees
    normalized = OpenReceive::Nwc.normalize_transaction(
      "type" => "incoming", "paymentHash" => "A" * 64, "amount" => 1000,
      "settled" => true, "feesPaid" => "21"
    )
    assert_equal "settled", normalized["transaction_state"]
    assert_equal 21, normalized["fees_paid_msats"]
    assert_equal "a" * 64, normalized["payment_hash"]
    assert OpenReceive.settled?(normalized)

    paid = OpenReceive::Nwc.normalize_transaction(
      "payment_hash" => "b" * 64, "state" => "confirmed", "paid" => true, "fees_paid" => 0
    )
    # An unrecognized raw state degrades to the boolean fallback, like JS.
    assert_equal "settled", paid["transaction_state"]
    assert_equal 0, paid["fees_paid_msats"]

    refute OpenReceive::Nwc.normalize_transaction("payment_hash" => "c" * 64).key?("fees_paid_msats")
    refute OpenReceive::Nwc.normalize_transaction("payment_hash" => "c" * 64, "settled" => false)
      .key?("transaction_state")
  end
end

class OpenReceivePaymentsWalkTest < Minitest::Test
  class PagingClient
    attr_reader :requests

    def initialize(pages)
      @pages = pages
      @requests = []
    end

    def list_transactions(request)
      @requests << request
      page = @requests.length > @pages.length ? [] : @pages.fetch(@requests.length - 1)
      { "transactions" => page }
    end
  end

  def row(payment_hash, state: "settled")
    { "type" => "incoming", "payment_hash" => payment_hash, "state" => state, "amount" => 1000 }
  end

  def full_page(start)
    Array.new(OpenReceive::TRANSACTION_PAGE_LIMIT) { |index| row(format("%064x", start + index)) }
  end

  def test_a_short_page_ends_the_walk_untruncated
    client = PagingClient.new([[row("a" * 64), { "type" => "outgoing", "payment_hash" => "b" * 64 }, { "invoice" => "no-hash" }]])
    scan = OpenReceive.list_incoming_transactions(
      client: client, expected: ["A" * 64], from: 100, until_time: 200
    )
    refute scan.fetch(:truncated)
    assert_equal ["a" * 64], scan.fetch(:rows).keys
    assert_equal "settled", scan.fetch(:rows).fetch("a" * 64)["transaction_state"]
    assert_equal(
      [{ "type" => "incoming", "limit" => 20, "offset" => 0, "from" => 100, "until" => 200 }],
      client.requests
    )
  end

  def test_the_walk_stops_untruncated_once_every_expected_hash_is_seen
    target = format("%064x", 7)
    client = PagingClient.new([full_page(0), full_page(20)])
    scan = OpenReceive.list_incoming_transactions(client: client, expected: [target])
    refute scan.fetch(:truncated)
    assert_equal 1, client.requests.length
    assert scan.fetch(:rows).key?(target)
  end

  def test_hitting_the_page_cap_marks_the_scan_truncated
    client = PagingClient.new([full_page(0), full_page(20), full_page(40)])
    scan = OpenReceive.list_incoming_transactions(client: client, expected: ["f" * 64], max_pages: 2)
    assert scan.fetch(:truncated)
    assert_equal 2, client.requests.length
    assert_equal [0, 20], client.requests.map { |request| request["offset"] }
    refute scan.fetch(:rows).key?("f" * 64)
  end

  def test_a_wallet_that_ignores_offset_stops_early_and_stays_truncated
    client = PagingClient.new([full_page(0), full_page(0), full_page(0), full_page(0)])
    scan = OpenReceive.list_incoming_transactions(client: client, expected: ["f" * 64], max_pages: 10)
    assert scan.fetch(:truncated)
    assert_equal 2, client.requests.length
  end

  def test_unpaid_scans_ask_for_unpaid_rows_and_bad_inputs_raise
    client = PagingClient.new([[]])
    OpenReceive.list_incoming_transactions(client: client, expected: [], include_unpaid: true)
    assert_equal true, client.requests.fetch(0)["unpaid"]

    assert_raises(ArgumentError) do
      OpenReceive.list_incoming_transactions(client: client, expected: ["nope"])
    end
    assert_raises(ArgumentError) do
      OpenReceive.list_incoming_transactions(client: client, expected: [], max_pages: 0)
    end
    assert_raises(ArgumentError) do
      OpenReceive.list_incoming_transactions(client: client, expected: [], from: -1)
    end
  end
end
