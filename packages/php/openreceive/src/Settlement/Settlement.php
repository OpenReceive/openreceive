<?php

declare(strict_types=1);

namespace OpenReceive\Settlement;

use OpenReceive\Support\Integers;
use OpenReceive\Support\Records;

/**
 * The shared settlement classification rule (spec/test-vectors/settlement-detection.json):
 * settled requires settled_at > 0 or a settled state; a preimage alone is
 * never final proof. Raw wallet states compare case-insensitively.
 */
final class Settlement
{
    public static function isSettled(mixed $transaction): bool
    {
        $data = Records::asArray($transaction);
        $settledAt = $data['settled_at'] ?? null;
        $positiveSettledAt = false;
        if ($settledAt !== null) {
            try {
                $positiveSettledAt = Integers::parse($settledAt, 'settled_at') > 0;
            } catch (\InvalidArgumentException) {
                $positiveSettledAt = false;
            }
        }
        return $positiveSettledAt || self::hasState($data, 'settled');
    }

    /** settled | expired | failed | pending — the 4-way classification reconciliation transitions on. */
    public static function status(mixed $transaction): string
    {
        $data = Records::asArray($transaction);
        if (self::isSettled($data)) {
            return 'settled';
        }
        if (self::hasState($data, 'expired')) {
            return 'expired';
        }
        if (self::hasState($data, 'failed')) {
            return 'failed';
        }
        return 'pending';
    }

    /** @param array<string, mixed> $data */
    private static function hasState(array $data, string $expected): bool
    {
        foreach ([$data['state'] ?? null, $data['transaction_state'] ?? null] as $value) {
            if (is_string($value) && strtolower($value) === $expected) {
                return true;
            }
        }
        return false;
    }
}
