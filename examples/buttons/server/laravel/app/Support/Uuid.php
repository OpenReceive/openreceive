<?php

declare(strict_types=1);

namespace App\Support;

/** A uuid, and nothing else: the shop's ids reach it from cookies and URLs the browser sent. */
final class Uuid
{
    public const PATTERN = '/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i';

    public static function valid(mixed $value): bool
    {
        return is_string($value) && preg_match(self::PATTERN, $value) === 1;
    }
}
