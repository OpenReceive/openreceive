<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop;

use Brick\Math\BigDecimal;
use Brick\Math\RoundingMode;

/**
 * Order totals as decimal strings. HikaShop stores them as DECIMAL(17,5),
 * which MySQL hands over as strings; they are rounded here as exact
 * decimals, never as binary floats.
 */
final class Amounts
{
    /**
     * The total, rounded half up to the currency's decimals and padded to
     * exactly that many: '12.50000' with 2 is '12.50'.
     */
    public static function total(string $total, int $decimals): string
    {
        if (!preg_match('/\A[0-9]{1,18}(\.[0-9]{1,9})?\z/', $total)) {
            throw new \InvalidArgumentException("Not a non-negative decimal amount: {$total}");
        }
        return (string) BigDecimal::of($total)->toScale(max(0, min(6, $decimals)), RoundingMode::HalfUp);
    }

    public static function isPositive(string $value): bool
    {
        return BigDecimal::of($value)->isPositive();
    }
}
