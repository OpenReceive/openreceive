<?php

declare(strict_types=1);

namespace OpenReceive\Tests;

/**
 * Reads the shared cross-language vectors by relative path. The coverage
 * detector (tools/validate/vector-coverage.mjs) greps each test source for
 * `vector('<family>')` or `<family>.json`, so tests call these with the
 * literal family name.
 */
trait VectorSupport
{
    public static function vectorsDir(): string
    {
        return dirname(__DIR__, 4) . '/spec/test-vectors';
    }

    /** @return array<string, mixed> */
    public static function vector(string $family): array
    {
        return self::readJson(self::vectorsDir() . "/{$family}.json");
    }

    /** Key-order-insensitive deep equality (Ruby hash ==), for wire records whose key order is not contractual. */
    public static function assertSameRecord(mixed $expected, mixed $actual, string $message = ''): void
    {
        \PHPUnit\Framework\Assert::assertSame(self::canonical($expected), self::canonical($actual), $message);
    }

    private static function canonical(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        $result = array_map([self::class, 'canonical'], $value);
        if (!array_is_list($result)) {
            ksort($result);
        }
        return $result;
    }

    /** @return array<string, mixed> */
    public static function readJson(string $path): array
    {
        $text = file_get_contents($path);
        if ($text === false) {
            throw new \RuntimeException("cannot read vector {$path}");
        }
        /** @var array<string, mixed> $decoded */
        $decoded = json_decode($text, true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
        return $decoded;
    }
}
