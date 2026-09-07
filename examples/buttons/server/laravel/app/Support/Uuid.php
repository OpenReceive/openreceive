<?php

declare(strict_types=1);

namespace App\Support;

/** A uuid, and nothing else: the shop's ids reach it from cookies and URLs the browser sent. */
final class Uuid
{
    public const PATTERN = '/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i';

    /** The same shape as a route constraint (no delimiters, no anchors). */
    public const ROUTE_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

    public static function valid(mixed $value): bool
    {
        return is_string($value) && preg_match(self::PATTERN, $value) === 1;
    }
}
