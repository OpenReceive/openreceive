<?php

declare(strict_types=1);

namespace OpenReceive\Support;

/**
 * Integer coercion at the wire boundary. The Ruby engine leans on
 * `Integer(value)`: accept ints and integral strings (and floats that are
 * exactly integral, which json_decode produces for large or exponent-form
 * numbers), refuse everything else. Never a silent float truncation.
 */
final class Integers
{
    public static function parse(mixed $value, string $label = 'value'): int
    {
        if (is_int($value)) {
            return $value;
        }
        if (is_bool($value) || $value === null) {
            throw new \InvalidArgumentException("{$label} must be an integer.");
        }
        if (is_float($value)) {
            if (!is_finite($value) || floor($value) !== $value || abs($value) > PHP_INT_MAX) {
                throw new \InvalidArgumentException("{$label} must be an integer.");
            }
            return (int) $value;
        }
        if (is_string($value) && preg_match('/\A\s*[+-]?\d+\s*\z/', $value) === 1) {
            $trimmed = trim($value);
            // A digit string wider than PHP_INT_MAX silently becomes a float
            // through (int); compare as decimal strings instead.
            $digits = ltrim($trimmed, '+-');
            $negative = str_starts_with($trimmed, '-');
            $limit = $negative ? '9223372036854775808' : '9223372036854775807';
            $digits = ltrim($digits, '0');
            if ($digits === '') {
                return 0;
            }
            if (strlen($digits) > strlen($limit) || (strlen($digits) === strlen($limit) && strcmp($digits, $limit) > 0)) {
                throw new \InvalidArgumentException("{$label} is out of range.");
            }
            return (int) $trimmed;
        }
        throw new \InvalidArgumentException("{$label} must be an integer.");
    }

    public static function optional(mixed $value, string $label = 'value'): ?int
    {
        return $value === null ? null : self::parse($value, $label);
    }
}
