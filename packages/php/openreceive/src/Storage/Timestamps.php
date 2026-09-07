<?php

declare(strict_types=1);

namespace OpenReceive\Storage;

use OpenReceive\Support\Integers;

/**
 * The payments table stores datetime columns (the Rails shape) in UTC; the
 * engine computes in unix seconds. Both directions live here so no column is
 * ever read as local time.
 */
final class Timestamps
{
    private const FORMAT = 'Y-m-d H:i:s';

    public static function toDb(int $unixSeconds): string
    {
        return (new \DateTimeImmutable("@{$unixSeconds}"))->setTimezone(new \DateTimeZone('UTC'))->format(self::FORMAT);
    }

    public static function fromDb(mixed $value, string $column): int
    {
        if ($value === null) {
            throw new \InvalidArgumentException("{$column} is null");
        }
        if (is_int($value)) {
            return $value;
        }
        $text = trim((string) $value);
        if (preg_match('/\A\d+\z/', $text) === 1) {
            return Integers::parse($text, $column);
        }
        // Drivers hand back "2026-01-02 03:04:05", with optional fraction and offset.
        $normalized = preg_replace('/\.\d+/', '', str_replace('T', ' ', $text)) ?? $text;
        $parsed = \DateTimeImmutable::createFromFormat('!' . self::FORMAT, substr($normalized, 0, 19), new \DateTimeZone('UTC'));
        if ($parsed === false) {
            throw new \InvalidArgumentException("{$column} is not a datetime: {$text}");
        }
        return $parsed->getTimestamp();
    }

    public static function optionalFromDb(mixed $value, string $column): ?int
    {
        return $value === null ? null : self::fromDb($value, $column);
    }
}
