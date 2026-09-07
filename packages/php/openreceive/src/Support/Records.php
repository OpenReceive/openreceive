<?php

declare(strict_types=1);

namespace OpenReceive\Support;

/**
 * Wire payloads reach the engine as PHP arrays, stdClass objects (a JSON
 * decode without `assoc`) or JsonSerializable value objects. These helpers
 * flatten that to string-keyed arrays; they differ only in what they do with
 * a non-record. `asArray` tolerates it and returns [] — use it on anything a
 * third party supplied. `requireArray` does not — use it where the caller has
 * already proven the value is a record, so a missing record fails loudly at
 * the source instead of as an undefined-index warning later. The Ruby
 * `stringify` / `as_string_keys` pair.
 */
final class Records
{
    /** @return array<string, mixed> */
    public static function asArray(mixed $value): array
    {
        if (is_array($value)) {
            return self::stringKeys($value);
        }
        if ($value instanceof \JsonSerializable) {
            $serialized = $value->jsonSerialize();
            return is_array($serialized) || is_object($serialized) ? self::asArray($serialized) : [];
        }
        if ($value instanceof \stdClass) {
            return self::stringKeys(get_object_vars($value));
        }
        return [];
    }

    /** @return array<string, mixed> */
    public static function requireArray(mixed $value, string $label = 'value'): array
    {
        if (!is_array($value) && !($value instanceof \stdClass) && !($value instanceof \JsonSerializable)) {
            throw new \InvalidArgumentException("{$label} must be an object.");
        }
        return self::asArray($value);
    }

    /** True for a JSON object shape: an array whose keys are not a 0..n-1 list. */
    public static function isRecord(mixed $value): bool
    {
        if ($value instanceof \stdClass) {
            return true;
        }
        if (!is_array($value)) {
            return false;
        }
        return $value === [] || !array_is_list($value);
    }

    /** A record with the given key present and non-null. */
    public static function has(array $record, string $key): bool
    {
        return array_key_exists($key, $record) && $record[$key] !== null;
    }

    /**
     * Drop null entries (the Ruby `compact`).
     *
     * @param array<string, mixed> $record
     * @return array<string, mixed>
     */
    public static function compact(array $record): array
    {
        return array_filter($record, static fn (mixed $value): bool => $value !== null);
    }

    /**
     * @param array<array-key, mixed> $value
     * @return array<string, mixed>
     */
    private static function stringKeys(array $value): array
    {
        $result = [];
        foreach ($value as $key => $item) {
            $result[(string) $key] = $item;
        }
        return $result;
    }
}
