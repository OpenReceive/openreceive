# frozen_string_literal: true

require "minitest/autorun"
require "openreceive/server"

# Mirrors the readUnixSeconds and amount-formatting parts of
# tests/fixedfloat.test.mjs — provider timestamps and msat→BTC conversions
# must stay on integer/rational paths in both engines. Change both together.
class FixedFloatParsingTest < Minitest::Test
  PROVIDER = OpenReceive::Server::Swap::FixedFloatProvider
  MAX_SAFE_INTEGER = OpenReceive::Server::Swap::FixedFloatRates::MAX_SAFE_INTEGER

  def test_read_unix_seconds_accepts_integer_timestamps
    assert_equal 1_700_000_000, PROVIDER.read_unix_seconds(1_700_000_000)
    assert_equal 0, PROVIDER.read_unix_seconds(0)
    assert_equal 1_700_000_000, PROVIDER.read_unix_seconds("1700000000")
    assert_equal 1_700_000_000, PROVIDER.read_unix_seconds(" 1700000000 ")
    assert_equal MAX_SAFE_INTEGER, PROVIDER.read_unix_seconds(MAX_SAFE_INTEGER.to_s)
  end

  def test_read_unix_seconds_accepts_whole_valued_decimal_and_exponent_strings
    assert_equal 1_700_000_000, PROVIDER.read_unix_seconds("1700000000.0")
    assert_equal 1_700_000_000, PROVIDER.read_unix_seconds("1.7e9")
    assert_equal 1_700_000_000, PROVIDER.read_unix_seconds(1_700_000_000.0)
  end

  def test_read_unix_seconds_rejects_fractional_negative_and_malformed_values
    assert_nil PROVIDER.read_unix_seconds("1700000000.5")
    assert_nil PROVIDER.read_unix_seconds(1_700_000_000.5)
    assert_nil PROVIDER.read_unix_seconds("-1")
    assert_nil PROVIDER.read_unix_seconds(-1)
    assert_nil PROVIDER.read_unix_seconds("soon")
    assert_nil PROVIDER.read_unix_seconds("")
    assert_nil PROVIDER.read_unix_seconds(nil)
    assert_nil PROVIDER.read_unix_seconds([1_700_000_000])
  end

  def test_read_unix_seconds_never_rounds_through_float_precision
    # Float("9007199254740993") silently becomes 9007199254740992.0; the JS
    # engine rejects anything past Number.MAX_SAFE_INTEGER, so Ruby must
    # reject rather than return a corrupted timestamp.
    assert_nil PROVIDER.read_unix_seconds((MAX_SAFE_INTEGER + 2).to_s)
    assert_nil PROVIDER.read_unix_seconds(MAX_SAFE_INTEGER + 1)
  end

  def test_amount_msats_to_btc_string_uses_exact_integer_math
    assert_equal "0.00000001", PROVIDER.amount_msats_to_btc_string(1_000)
    assert_equal "0.00000001", PROVIDER.amount_msats_to_btc_string(1)
    assert_equal "0.00000002", PROVIDER.amount_msats_to_btc_string(1_001)
    assert_equal "1", PROVIDER.amount_msats_to_btc_string(100_000_000_000)
    assert_equal "1.23456789", PROVIDER.amount_msats_to_btc_string(123_456_789_000)
    assert_equal "2.5", PROVIDER.amount_msats_to_btc_string(250_000_000_000)
    assert_equal "210000.00000001", PROVIDER.amount_msats_to_btc_string(21_000_000_000_001_000)
  end

  def test_amount_msats_to_btc_string_rejects_non_positive_and_non_integer_amounts
    assert_raises(ArgumentError) { PROVIDER.amount_msats_to_btc_string(0) }
    assert_raises(ArgumentError) { PROVIDER.amount_msats_to_btc_string(-1_000) }
    assert_raises(ArgumentError) { PROVIDER.amount_msats_to_btc_string(1000.0) }
    assert_raises(ArgumentError) { PROVIDER.amount_msats_to_btc_string("1000") }
  end
end
