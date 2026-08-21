# frozen_string_literal: true

module OpenReceive
  # Keccak-256 (the pre-NIST-padding variant Ethereum uses, which is NOT
  # Digest::SHA3). Needed only to verify EIP-55 checksums on refund addresses,
  # so this is a compact reference implementation rather than a dependency —
  # the core gem stays dependency-free.
  module Keccak256
    ROUNDS = 24
    RATE_BYTES = 136 # 1088-bit rate for Keccak-256.
    MASK = 0xffffffffffffffff

    ROUND_CONSTANTS = [
      0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000,
      0x000000000000808b, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
      0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
      0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003,
      0x8000000000008002, 0x8000000000000080, 0x000000000000800a, 0x800000008000000a,
      0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008
    ].freeze

    ROTATION_OFFSETS = [
      [0, 36, 3, 41, 18],
      [1, 44, 10, 45, 2],
      [62, 6, 43, 15, 61],
      [28, 55, 25, 21, 56],
      [27, 20, 39, 8, 14]
    ].freeze

    module_function

    def digest(message)
      state = Array.new(25, 0)
      padded = pad(message.to_s.b)
      padded.bytes.each_slice(RATE_BYTES) do |block|
        block.each_slice(8).with_index do |lane_bytes, lane|
          state[lane] ^= lane_bytes.each_with_index.sum { |byte, index| byte << (8 * index) }
        end
        keccak_f!(state)
      end
      # Keccak-256 output is the first 32 bytes of the rate portion.
      state[0, 4].flat_map { |lane| (0...8).map { |index| (lane >> (8 * index)) & 0xff } }.pack("C*")
    end

    def pad(message)
      # Keccak padding is 0x01 … 0x80 (SHA-3 would use 0x06 here).
      padding_length = RATE_BYTES - (message.bytesize % RATE_BYTES)
      padding = +"\x01" + ("\x00" * (padding_length - 1))
      padding[-1] = (padding[-1].ord | 0x80).chr
      message + padding
    end

    def keccak_f!(state)
      ROUNDS.times do |round|
        theta!(state)
        rho_pi_chi!(state)
        state[0] ^= ROUND_CONSTANTS[round]
      end
      state
    end

    def theta!(state)
      columns = (0...5).map do |x|
        (0...5).reduce(0) { |acc, y| acc ^ state[x + 5 * y] }
      end
      (0...5).each do |x|
        d = columns[(x + 4) % 5] ^ rotl(columns[(x + 1) % 5], 1)
        (0...5).each { |y| state[x + 5 * y] ^= d }
      end
    end

    def rho_pi_chi!(state)
      rotated = Array.new(25, 0)
      (0...5).each do |x|
        (0...5).each do |y|
          rotated[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROTATION_OFFSETS[x][y])
        end
      end
      (0...5).each do |y|
        row = (0...5).map { |x| rotated[x + 5 * y] }
        (0...5).each do |x|
          state[x + 5 * y] = row[x] ^ (~row[(x + 1) % 5] & MASK & row[(x + 2) % 5])
        end
      end
    end

    def rotl(value, offset)
      offset %= 64
      return value if offset.zero?

      ((value << offset) | (value >> (64 - offset))) & MASK
    end
  end
end
