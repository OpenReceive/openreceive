<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/** Bitcoin/Solana base58 decoding with the Bitcoin alphabet (Base58Check verification lives in SwapAddress). */
final class Base58
{
    public const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    /**
     * Returns null on invalid characters, else a list of byte values. Leading
     * "1" characters are leading zero bytes (matches the JS decodeBase58,
     * including the all-'1' zero-value input).
     *
     * @return list<int>|null
     */
    public static function decode(string $value): ?array
    {
        if ($value === '') {
            return null;
        }
        $map = array_flip(str_split(self::ALPHABET));
        $bytes = [];
        foreach (str_split($value) as $char) {
            if (!isset($map[$char])) {
                return null;
            }
            $carry = $map[$char];
            for ($index = 0, $count = count($bytes); $index < $count; $index++) {
                $carry += $bytes[$index] * 58;
                $bytes[$index] = $carry & 0xff;
                $carry >>= 8;
            }
            while ($carry > 0) {
                $bytes[] = $carry & 0xff;
                $carry >>= 8;
            }
        }
        foreach (str_split($value) as $char) {
            if ($char !== '1') {
                break;
            }
            $bytes[] = 0;
        }
        return array_values(array_reverse($bytes));
    }
}
