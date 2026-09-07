<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * Keccak-256 (the pre-NIST-padding variant Ethereum uses, which is NOT PHP's
 * hash('sha3-256')). Needed only to verify EIP-55 checksums on refund
 * addresses, so this is a compact reference implementation rather than a
 * dependency — WordPress-friendly. Pinned by the swap-address vectors.
 */
final class Keccak256
{
    private const ROUNDS = 24;
    private const RATE_BYTES = 136;

    private const ROUND_CONSTANTS = [
        '0000000000000001', '0000000000008082', '800000000000808a', '8000000080008000',
        '000000000000808b', '0000000080000001', '8000000080008081', '8000000000008009',
        '000000000000008a', '0000000000000088', '0000000080008009', '000000008000000a',
        '000000008000808b', '800000000000008b', '8000000000008089', '8000000000008003',
        '8000000000008002', '8000000000000080', '000000000000800a', '800000008000000a',
        '8000000080008081', '8000000000008080', '0000000080000001', '8000000080008008',
    ];

    private const ROTATION_OFFSETS = [
        [0, 36, 3, 41, 18],
        [1, 44, 10, 45, 2],
        [62, 6, 43, 15, 61],
        [28, 55, 25, 21, 56],
        [27, 20, 39, 8, 14],
    ];

    /** Raw 32-byte digest. Lanes are PHP ints used as 64-bit two's-complement words. */
    public static function digest(string $message): string
    {
        $state = array_fill(0, 25, 0);
        $padded = self::pad($message);
        $blocks = str_split($padded, self::RATE_BYTES);
        foreach ($blocks as $block) {
            for ($lane = 0; $lane < self::RATE_BYTES / 8; $lane++) {
                $word = 0;
                for ($index = 0; $index < 8; $index++) {
                    $word |= ord($block[$lane * 8 + $index]) << (8 * $index);
                }
                $state[$lane] ^= $word;
            }
            self::keccakF($state);
        }
        $out = '';
        for ($lane = 0; $lane < 4; $lane++) {
            for ($index = 0; $index < 8; $index++) {
                $out .= chr(($state[$lane] >> (8 * $index)) & 0xff);
            }
        }
        return $out;
    }

    public static function hex(string $message): string
    {
        return bin2hex(self::digest($message));
    }

    private static function pad(string $message): string
    {
        // Keccak padding is 0x01 … 0x80 (SHA-3 would use 0x06 here).
        $paddingLength = self::RATE_BYTES - (strlen($message) % self::RATE_BYTES);
        $padding = "\x01" . str_repeat("\x00", $paddingLength - 1);
        $padding[$paddingLength - 1] = chr(ord($padding[$paddingLength - 1]) | 0x80);
        return $message . $padding;
    }

    /** @param array<int, int> $state */
    private static function keccakF(array &$state): void
    {
        for ($round = 0; $round < self::ROUNDS; $round++) {
            // theta
            $columns = [];
            for ($x = 0; $x < 5; $x++) {
                $columns[$x] = $state[$x] ^ $state[$x + 5] ^ $state[$x + 10] ^ $state[$x + 15] ^ $state[$x + 20];
            }
            for ($x = 0; $x < 5; $x++) {
                $d = $columns[($x + 4) % 5] ^ self::rotl($columns[($x + 1) % 5], 1);
                for ($y = 0; $y < 5; $y++) {
                    $state[$x + 5 * $y] ^= $d;
                }
            }
            // rho + pi
            $rotated = array_fill(0, 25, 0);
            for ($x = 0; $x < 5; $x++) {
                for ($y = 0; $y < 5; $y++) {
                    $rotated[$y + 5 * ((2 * $x + 3 * $y) % 5)] = self::rotl($state[$x + 5 * $y], self::ROTATION_OFFSETS[$x][$y]);
                }
            }
            // chi
            for ($y = 0; $y < 5; $y++) {
                $row = [$rotated[5 * $y], $rotated[5 * $y + 1], $rotated[5 * $y + 2], $rotated[5 * $y + 3], $rotated[5 * $y + 4]];
                for ($x = 0; $x < 5; $x++) {
                    $state[$x + 5 * $y] = $row[$x] ^ ((~$row[($x + 1) % 5]) & $row[($x + 2) % 5]);
                }
            }
            // iota
            $state[0] ^= (int) hexdec(substr(self::ROUND_CONSTANTS[$round], 0, 8)) << 32
                | (int) hexdec(substr(self::ROUND_CONSTANTS[$round], 8, 8));
        }
    }

    private static function rotl(int $value, int $offset): int
    {
        $offset %= 64;
        if ($offset === 0) {
            return $value;
        }
        // Logical right shift of a 64-bit word in PHP's signed ints.
        $right = ($value >> (64 - $offset)) & ((1 << $offset) - 1);
        return ($value << $offset) | $right;
    }
}
