<?php

declare(strict_types=1);

namespace OpenReceive\Money;

use Brick\Math\BigDecimal;
use Brick\Math\Exception\MathException;
use Brick\Math\RoundingMode;
use OpenReceive\Kernel;
use OpenReceive\Support\Integers;

/**
 * Exact money math. Fiat values and BTC prices are decimal STRINGS parsed
 * into BigDecimal; msats are ints. No binary float ever touches an amount:
 * `fiat-to-msats.usd` and `amount-boundaries` are the acceptance tests.
 */
final class Money
{
    private const SATS_PER_BTC = 100_000_000;
    private const DECIMAL_PATTERN = '/\A[0-9]+(?:\.[0-9]+)?\z/';

    /** ceil((fiat × 1e8) / price) — the shared ceil-to-whole-sat rule. */
    public static function quoteFiatToSats(mixed $fiatValue, mixed $btcFiatPrice): int
    {
        $fiat = self::decimal($fiatValue, 'fiat.value');
        $price = self::decimal($btcFiatPrice, 'btc_fiat_price');
        if (!$price->isPositive()) {
            throw new \InvalidArgumentException('btc_fiat_price must be greater than zero');
        }
        try {
            return $fiat->multipliedBy(self::SATS_PER_BTC)->dividedBy($price, 0, RoundingMode::Ceiling)->toInt();
        } catch (MathException $e) {
            throw new \InvalidArgumentException('amount_msats is outside the safe range', 0, $e);
        }
    }

    /** Bounded like every other amount path: a large fiat value at a low price must not pass 2^53-1. */
    public static function quoteFiatToMsats(mixed $fiatValue, mixed $btcFiatPrice): int
    {
        $sats = self::quoteFiatToSats($fiatValue, $btcFiatPrice);
        if ($sats > intdiv(Kernel::MAX_AMOUNT_MSATS, 1000)) {
            throw new \InvalidArgumentException('amount_msats is outside the safe range');
        }
        return self::boundedMsats($sats * 1000);
    }

    /** BTC / SAT / SATS amounts to msats; the amount must resolve to whole satoshis. */
    public static function directToMsats(string $currency, mixed $value): int
    {
        $amount = self::decimal($value, 'amount.value');
        $sats = match ($currency) {
            'BTC' => $amount->multipliedBy(self::SATS_PER_BTC),
            'SAT', 'SATS' => $amount,
            default => throw new \InvalidArgumentException('amount.currency must be BTC, SAT, or SATS'),
        };
        try {
            $whole = $sats->toScale(0, RoundingMode::Unnecessary)->toBigInteger();
        } catch (MathException $e) {
            throw new \InvalidArgumentException('amount must resolve to whole satoshis', 0, $e);
        }
        if ($whole->isGreaterThan(intdiv(Kernel::MAX_AMOUNT_MSATS, 1000))) {
            throw new \InvalidArgumentException('amount_msats is outside the safe range');
        }
        return self::boundedMsats($whole->toInt() * 1000);
    }

    public static function boundedMsats(mixed $value): int
    {
        $amount = Integers::parse($value, 'amount_msats');
        if ($amount < Kernel::MIN_AMOUNT_MSATS || $amount > Kernel::MAX_AMOUNT_MSATS) {
            throw new \InvalidArgumentException('amount_msats is outside the safe range');
        }
        return $amount;
    }

    /** A positive decimal string (digits with an optional fraction) as BigDecimal. */
    public static function decimal(mixed $value, string $field): BigDecimal
    {
        if (is_int($value)) {
            $text = (string) $value;
        } elseif (is_string($value)) {
            $text = $value;
        } else {
            // Floats and everything else are refused: a float has already lost
            // the exactness this function exists to keep.
            throw new \InvalidArgumentException("{$field} must be a positive decimal string");
        }
        if (preg_match(self::DECIMAL_PATTERN, $text) !== 1) {
            throw new \InvalidArgumentException("{$field} must be a positive decimal string");
        }
        $parsed = BigDecimal::of($text);
        if (!$parsed->isPositive()) {
            throw new \InvalidArgumentException("{$field} must be greater than zero");
        }
        return $parsed;
    }
}
