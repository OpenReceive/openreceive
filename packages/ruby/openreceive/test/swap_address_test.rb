# frozen_string_literal: true

require "minitest/autorun"
require "openreceive"

# Mirrors tests/swap-address.test.mjs — the same inputs must classify
# identically in both engines. Change both together.
class SwapAddressTest < Minitest::Test
  ETH = "0x2222222222222222222222222222222222222222"
  # EIP-55 checksummed (mixed case).
  ETH_CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
  # One capitalization bit flipped: right shape, wrong EIP-55 checksum.
  ETH_BAD_CHECKSUM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"
  SOL = "7EqQdEULxWcraVQ3XXtK5nGJm6tQ3nqJkGqZQ6c8bqKx"
  SOL_FULL = "BfMe1deFYJwaSeD9XoN1X8xw1PtcYjginrbvkQjS9w9U"
  SOL_TRUNCATED = "BfMe1deFYJwaSeD9XoN1X8xw1PtcYjginrbvkQjS9"
  TRX = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"
  # Same shape, last character changed: the checksum no longer matches.
  TRX_BAD_CHECKSUM = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBg"

  ADDR = OpenReceive::SwapAddress

  def test_network_for_pay_in_asset_maps_every_shipped_asset
    assert_equal "ETH", ADDR.network_for_pay_in_asset("ETH_ETH")
    assert_equal "ETH", ADDR.network_for_pay_in_asset("USDT_ETH")
    assert_equal "ETH", ADDR.network_for_pay_in_asset("USDC_ETH")
    assert_equal "SOL", ADDR.network_for_pay_in_asset("SOL_SOL")
    assert_equal "SOL", ADDR.network_for_pay_in_asset("USDT_SOL")
    assert_equal "SOL", ADDR.network_for_pay_in_asset("USDC_SOL")
    assert_equal "TRX", ADDR.network_for_pay_in_asset("USDT_TRON")
    assert_nil ADDR.network_for_pay_in_asset("UNKNOWN")
  end

  def test_accepts_well_formed_eth_sol_trx_addresses
    assert ADDR.valid_for_network?("ETH", ETH)
    assert ADDR.valid_for_network?("SOL", SOL)
    assert ADDR.valid_for_network?("SOL", SOL_FULL)
    assert ADDR.valid_for_network?("TRX", TRX)
    assert ADDR.valid_for_network?("TRON", TRX)
  end

  def test_rejects_truncated_solana_addresses
    assert SOL_TRUNCATED.length >= 32
    refute ADDR.valid_for_network?("SOL", SOL_TRUNCATED)
    refute ADDR.valid_for_pay_in_asset?("SOL_SOL", SOL_TRUNCATED)
    assert_match(/full address/, ADDR.refund_address_error("SOL_SOL", SOL_TRUNCATED, "Solana"))
  end

  def test_rejects_wrong_network_and_malformed_addresses
    refute ADDR.valid_for_network?("ETH", SOL)
    refute ADDR.valid_for_network?("ETH", TRX)
    refute ADDR.valid_for_network?("ETH", "0xabc")
    refute ADDR.valid_for_network?("ETH", " #{ETH}")
    refute ADDR.valid_for_network?("SOL", ETH)
    refute ADDR.valid_for_network?("SOL", TRX)
    refute ADDR.valid_for_network?("SOL", "O0Il")
    refute ADDR.valid_for_network?("TRX", ETH)
    refute ADDR.valid_for_network?("TRX", SOL)
    refute ADDR.valid_for_network?("TRX", "XYZ")
  end

  def test_pay_in_asset_checks_cover_every_shipped_asset
    %w[ETH_ETH USDT_ETH USDC_ETH SOL_SOL USDT_SOL USDC_SOL USDT_TRON].each do |asset|
      expected_network = ADDR.network_for_pay_in_asset(asset)
      assert_equal ADDR.valid_for_network?(expected_network, ETH),
                   ADDR.valid_for_pay_in_asset?(asset, ETH), asset
      assert_equal ADDR.valid_for_network?(expected_network, SOL),
                   ADDR.valid_for_pay_in_asset?(asset, SOL), asset
      assert_equal ADDR.valid_for_network?(expected_network, TRX),
                   ADDR.valid_for_pay_in_asset?(asset, TRX), asset
    end
    assert ADDR.valid_for_pay_in_asset?("ETH_ETH", ETH)
    assert ADDR.valid_for_pay_in_asset?("SOL_SOL", SOL)
    assert ADDR.valid_for_pay_in_asset?("USDT_TRON", TRX)
    refute ADDR.valid_for_pay_in_asset?("ETH_ETH", SOL)
    refute ADDR.valid_for_pay_in_asset?("SOL_SOL", ETH)
    refute ADDR.valid_for_pay_in_asset?("USDT_TRON", ETH)
  end

  def test_refund_address_error_returns_network_specific_copy
    assert_nil ADDR.refund_address_error("ETH_ETH", "", "Ethereum")
    assert_nil ADDR.refund_address_error("ETH_ETH", ETH, "Ethereum")
    assert_match(/Ethereum.*0x/, ADDR.refund_address_error("ETH_ETH", SOL, "Ethereum"))
    assert_match(/Solana/, ADDR.refund_address_error("SOL_SOL", ETH, "Solana"))
    assert_match(/Tron.*starting with T/, ADDR.refund_address_error("USDT_TRON", ETH, "Tron"))
    assert_match(/Ethereum.*0x/, ADDR.refund_address_error("USDC_ETH", TRX, "Ethereum"))
    assert_match(/Solana/, ADDR.refund_address_error("USDT_SOL", TRX, "Solana"))
  end

  def test_refund_address_error_distinguishes_checksum_failures_from_shape_failures
    assert ADDR.valid_for_network?("ETH", ETH_CHECKSUMMED)
    refute ADDR.valid_for_network?("ETH", ETH_BAD_CHECKSUM)
    refute ADDR.valid_for_network?("TRX", TRX_BAD_CHECKSUM)
    assert_match(/Ethereum address failed its checksum/,
                 ADDR.refund_address_error("ETH_ETH", ETH_BAD_CHECKSUM, "Ethereum"))
    assert_match(/Ethereum address failed its checksum/,
                 ADDR.refund_address_error("USDT_ETH", ETH_BAD_CHECKSUM, "Ethereum"))
    assert_match(/Tron address failed its checksum/,
                 ADDR.refund_address_error("USDT_TRON", TRX_BAD_CHECKSUM, "Tron"))
    assert_nil ADDR.refund_address_error("ETH_ETH", ETH_CHECKSUMMED, "Ethereum")
  end

  def test_decode_base58_decodes_the_all_one_system_program_address
    decoded = ADDR.decode_base58("1" * 32)
    assert_equal 32, decoded.length
    assert decoded.all?(&:zero?)
    assert ADDR.valid_for_network?("SOL", "11111111111111111111111111111111")
  end
end
