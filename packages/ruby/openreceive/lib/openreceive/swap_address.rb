# frozen_string_literal: true

require "digest"
require_relative "keccak256"

module OpenReceive
  # Ruby port of packages/js/core/src/swap/address.ts: address shape checks for
  # swap deposit/refund networks, shared by the settlement engine so both
  # engines apply one rule set.
  #
  # These are checksum checks, not shape guards: a refund goes to whatever
  # address the payer typed, so a transposed character must be refused here
  # rather than sent somewhere unrecoverable. Tron is Base58Check
  # (double-SHA-256 tail over the 0x41-prefixed payload), Ethereum is verified
  # against EIP-55 whenever the address carries mixed case (an all-lower or
  # all-upper address has no checksum bits to verify, and wallets accept it),
  # and Solana must decode to exactly a 32-byte ed25519 public key.
  module SwapAddress
    BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    BASE58_MAP = BASE58_ALPHABET.each_char.with_index.to_h.freeze

    ETH_ADDRESS_PATTERN = /\A0x[0-9a-fA-F]{40}\z/
    TRON_ADDRESS_PREFIX = 0x41
    BASE58CHECK_CHECKSUM_BYTES = 4
    TRON_ADDRESS_PATTERN = /\AT[1-9A-HJ-NP-Za-km-z]{33}\z/
    SOLANA_ADDRESS_PATTERN = /\A[1-9A-HJ-NP-Za-km-z]{32,44}\z/

    module_function

    # Bitcoin/Solana base58 decode. Returns nil on invalid characters, else an
    # array of byte values. Leading "1" chars are treated as leading zero
    # bytes (matches JS decodeBase58, including the all-'1' zero-value input).
    def decode_base58(value)
      text = value.to_s
      return nil if text.empty?
      bytes = []
      text.each_char do |char|
        digit = BASE58_MAP[char]
        return nil if digit.nil?
        carry = digit
        index = 0
        while index < bytes.length
          carry += bytes[index] * 58
          bytes[index] = carry & 0xff
          carry >>= 8
          index += 1
        end
        while carry.positive?
          bytes << (carry & 0xff)
          carry >>= 8
        end
      end
      text.each_char do |char|
        break unless char == "1"
        bytes << 0
      end
      bytes.reverse
    end

    def valid_solana_address?(address)
      # Typical encoded length is 32–44; still require a 32-byte pubkey decode.
      return false unless SOLANA_ADDRESS_PATTERN.match?(address)
      decoded = decode_base58(address)
      !decoded.nil? && decoded.length == 32
    end

    def valid_tron_address?(address)
      return false unless TRON_ADDRESS_PATTERN.match?(address)
      decoded = decode_base58(address)
      return false if decoded.nil? || decoded.length != 21 + BASE58CHECK_CHECKSUM_BYTES
      return false unless decoded[0] == TRON_ADDRESS_PREFIX

      payload = decoded[0, 21].pack("C*")
      expected = Digest::SHA256.digest(Digest::SHA256.digest(payload)).bytes
      decoded[21, BASE58CHECK_CHECKSUM_BYTES] == expected[0, BASE58CHECK_CHECKSUM_BYTES]
    end

    def valid_ethereum_address?(address)
      return false unless ETH_ADDRESS_PATTERN.match?(address)

      body = address[2..]
      lowercase = body.downcase
      # No mixed case means no EIP-55 bits to verify.
      return true if body == lowercase || body == body.upcase

      digest = Keccak256.digest(lowercase).bytes
      lowercase.each_char.with_index.all? do |character, index|
        next true unless character.between?("a", "f")

        nibble = index.even? ? (digest[index / 2] >> 4) : (digest[index / 2] & 0x0f)
        (nibble >= 8) == (body[index] == character.upcase)
      end
    end

    def valid_for_network?(network, address)
      return false if address.length > 200 || address.match?(/\s/)
      return valid_ethereum_address?(address) if network == "ETH"
      return valid_solana_address?(address) if network == "SOL"
      return valid_tron_address?(address) if network == "TRX" || network == "TRON"

      # An unknown network has no rule to apply, so nothing may be accepted for
      # it (the old `length >= 5` fallback validated almost anything).
      false
    end

    # Resolve the address network from an OpenReceive pay_in_asset code
    # (USDT_ETH → "ETH", USDT_TRON → "TRX", SOL_SOL → "SOL"), or nil.
    def network_for_pay_in_asset(pay_in_asset)
      suffix = pay_in_asset.to_s.split("_").last&.upcase
      return "ETH" if suffix == "ETH"
      return "SOL" if suffix == "SOL"
      return "TRX" if suffix == "TRON" || suffix == "TRX"
      nil
    end

    def valid_for_pay_in_asset?(pay_in_asset, address)
      network = network_for_pay_in_asset(pay_in_asset)
      if network.nil?
        return address.length >= 5 && address.length <= 200 && !address.match?(/\s/)
      end
      valid_for_network?(network, address)
    end

    # User-facing refund address error, or nil when the address is empty
    # (callers keep required/empty-field handling) or valid. Copy mirrors the
    # JS getSwapRefundAddressError strings exactly.
    def refund_address_error(pay_in_asset, address, network_label)
      trimmed = address.to_s.strip
      return nil if trimmed.empty?
      return nil if valid_for_pay_in_asset?(pay_in_asset, trimmed)
      network = network_for_pay_in_asset(pay_in_asset)
      if network == "ETH"
        if ETH_ADDRESS_PATTERN.match?(trimmed)
          return "That #{network_label} address failed its checksum. Copy it again from your wallet."
        end
        return "That doesn't look like an #{network_label} address. Use a 0x address."
      end
      if network == "TRX"
        if TRON_ADDRESS_PATTERN.match?(trimmed)
          return "That #{network_label} address failed its checksum. Copy it again from your wallet."
        end
        return "That doesn't look like a #{network_label} address. Use an address starting with T."
      end
      "That doesn't look like a #{network_label} address. Check you pasted the full address."
    end
  end
end
