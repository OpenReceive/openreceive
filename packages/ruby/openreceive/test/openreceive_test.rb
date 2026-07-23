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

  def test_nwc_list_limit_is_twenty
    assert_equal 20, OpenReceive.list_transactions_nip47_request("limit" => 20)["limit"]
    assert_raises(ArgumentError) { OpenReceive.list_transactions_nip47_request("limit" => 21) }
  end
end
