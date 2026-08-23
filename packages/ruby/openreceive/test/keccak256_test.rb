# frozen_string_literal: true

require "minitest/autorun"
require "openreceive"

# Known-answer vectors for the hand-rolled Keccak-256 in lib/openreceive/keccak256.rb.
# These are Keccak (0x01 padding) digests, not NIST SHA3-256 (0x06 padding):
# the empty-string digest is the quickest way to tell the two apart. The
# addresses are the EIP-55 specification's own examples, so a wrong digest
# surfaces here before it refuses a payer's real refund address.
class Keccak256Test < Minitest::Test
  DIGESTS = {
    "" => "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    "abc" => "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    "The quick brown fox jumps over the lazy dog" =>
      "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15"
  }.freeze

  EIP55_CHECKSUMMED = %w[
    0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed
    0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359
    0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB
  ].freeze
  # The first address above with one letter's case flipped.
  EIP55_CASE_FLIPPED = "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed"

  ADDR = OpenReceive::SwapAddress

  def test_digest_matches_keccak_256_known_answers
    DIGESTS.each do |message, expected_hex|
      assert_equal expected_hex, OpenReceive::Keccak256.digest(message).unpack1("H*"), message.inspect
    end
  end

  def test_eip55_specification_addresses_validate
    EIP55_CHECKSUMMED.each do |address|
      assert ADDR.valid_for_network?("ETH", address), address
    end
  end

  def test_case_flipped_eip55_address_fails_its_checksum
    refute ADDR.valid_for_network?("ETH", EIP55_CASE_FLIPPED)
  end
end
