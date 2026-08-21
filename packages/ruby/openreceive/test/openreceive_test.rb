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
end
