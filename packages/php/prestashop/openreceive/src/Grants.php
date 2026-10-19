<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive;

/**
 * The orders a browser may pay, as PrestaShop's encrypted cookie keeps them:
 * a comma-separated list of order ids, newest last, at most MAX long. The
 * cookie is PrestaShop's own and encrypted with the shop's key, so a visitor
 * cannot add an order to it.
 */
final class Grants
{
    public const MAX = 20;

    /** @return list<int> */
    public static function parse(string $value): array
    {
        $ids = [];
        foreach (explode(',', $value) as $part) {
            if (preg_match('/\A[1-9][0-9]{0,9}\z/', $part)) {
                $ids[] = (int) $part;
            }
        }
        return array_values(array_unique($ids));
    }

    public static function add(string $value, int $orderId): string
    {
        $ids = array_values(array_filter(self::parse($value), static fn (int $id): bool => $id !== $orderId));
        $ids[] = $orderId;
        return implode(',', array_slice($ids, -self::MAX));
    }

    public static function allows(string $value, int $orderId): bool
    {
        return $orderId > 0 && in_array($orderId, self::parse($value), true);
    }

    /** The checkout's token against the cookie's, in constant time. */
    public static function tokenMatches(string $expected, ?string $sent): bool
    {
        return preg_match('/\A[0-9a-f]{64}\z/', $expected) === 1 && is_string($sent) && hash_equals($expected, $sent);
    }
}
