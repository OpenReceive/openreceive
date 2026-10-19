<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive;

use Brick\Math\BigDecimal;
use Brick\Math\RoundingMode;

/**
 * Order totals as decimal strings. PrestaShop stores them as DECIMAL(20,6),
 * which MySQL hands over as strings; they are summed and rounded here as
 * exact decimals, never as binary floats.
 */
final class Amounts
{
    /**
     * The sum of order totals, rounded half up to the currency's decimals and
     * padded to exactly that many: '12.500000' with 2 is '12.50'.
     *
     * @param list<string> $totals
     */
    public static function total(array $totals, int $decimals): string
    {
        $sum = BigDecimal::zero();
        foreach ($totals as $total) {
            if (!preg_match('/\A[0-9]{1,18}(\.[0-9]{1,9})?\z/', $total)) {
                throw new \InvalidArgumentException("Not a non-negative decimal amount: {$total}");
            }
            $sum = $sum->plus(BigDecimal::of($total));
        }
        return (string) $sum->toScale(max(0, min(6, $decimals)), RoundingMode::HalfUp);
    }

    public static function isPositive(string $value): bool
    {
        return BigDecimal::of($value)->isPositive();
    }
}
