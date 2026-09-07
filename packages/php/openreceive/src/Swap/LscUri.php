<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * `lightning+swapconnect://host[:port][/path]?key=…&secret=…` — the one
 * connection string a swap provider is configured with (spec/test-vectors/lsc-uri.json).
 * Credentials are server-only: never logged, never serialized to a wire payload.
 */
final class LscUri
{
    public const SCHEME = 'lightning+swapconnect';
    public const ENV_NAMES = ['LSC_URI_PRIMARY', 'LSC_URI_BACKUP'];
    public const QUERY_PARAMETERS = ['key', 'secret'];
    public const MAX_URI_LENGTH = 8192;
    public const MAX_CREDENTIAL_LENGTH = 2048;

    /** @return array{uri_protocol: string, base_url: string, provider_id: string, key: string, secret: string} */
    public static function parse(mixed $value): array
    {
        $input = self::credential($value, 'LSC URI', self::MAX_URI_LENGTH);
        $parts = parse_url($input);
        if ($parts === false) {
            throw new \InvalidArgumentException('LSC URI is not a valid absolute URI.');
        }
        if (($parts['scheme'] ?? null) !== self::SCHEME) {
            throw new \InvalidArgumentException('LSC URI must use ' . self::SCHEME . '://.');
        }
        if (isset($parts['user']) || isset($parts['pass'])) {
            throw new \InvalidArgumentException('LSC URI must not use URI userinfo.');
        }
        $host = (string) ($parts['host'] ?? '');
        if ($host === '') {
            throw new \InvalidArgumentException('LSC URI requires a provider hostname.');
        }
        if (isset($parts['fragment'])) {
            throw new \InvalidArgumentException('LSC URI must not contain a fragment.');
        }
        $query = (string) ($parts['query'] ?? '');
        if (preg_match('/%(?![0-9a-f]{2})/i', $query) === 1) {
            throw new \InvalidArgumentException('LSC URI query encoding is invalid.');
        }
        $pairs = [];
        foreach ($query === '' ? [] : explode('&', $query) as $pair) {
            if ($pair === '') {
                continue;
            }
            $separator = strpos($pair, '=');
            $name = urldecode($separator === false ? $pair : substr($pair, 0, $separator));
            $pairs[] = [$name, urldecode($separator === false ? '' : substr($pair, $separator + 1))];
        }
        foreach ($pairs as [$name]) {
            if (!in_array($name, self::QUERY_PARAMETERS, true)) {
                throw new \InvalidArgumentException('LSC URI contains an unsupported query parameter.');
            }
        }
        $key = self::credential(self::singleParameter($pairs, 'key'), 'LSC URI key', self::MAX_CREDENTIAL_LENGTH);
        $secret = self::credential(self::singleParameter($pairs, 'secret'), 'LSC URI secret', self::MAX_CREDENTIAL_LENGTH);
        $path = self::normalizePath((string) ($parts['path'] ?? ''));
        $port = isset($parts['port']) ? ":{$parts['port']}" : '';
        return [
            'uri_protocol' => self::SCHEME . ':',
            'base_url' => "https://{$host}{$port}{$path}",
            'provider_id' => self::providerId($host, $parts['port'] ?? null, (string) ($parts['path'] ?? '')),
            'key' => $key,
            'secret' => $secret,
        ];
    }

    /**
     * LSC_URI_PRIMARY first, LSC_URI_BACKUP second — the order the service fails over in.
     *
     * @param array<string, mixed> $env
     * @return list<array{uri_protocol: string, base_url: string, provider_id: string, key: string, secret: string}>
     */
    public static function readEnvironment(array $env): array
    {
        $connections = [];
        $seen = [];
        foreach (self::ENV_NAMES as $name) {
            $value = trim((string) ($env[$name] ?? ''));
            if ($value === '') {
                continue;
            }
            try {
                $connection = self::parse($value);
                if (isset($seen[$connection['provider_id']])) {
                    throw new \InvalidArgumentException("{$name} duplicates another LSC provider id.");
                }
            } catch (\InvalidArgumentException $e) {
                throw new \InvalidArgumentException("{$name} is invalid: {$e->getMessage()}", 0, $e);
            }
            $seen[$connection['provider_id']] = true;
            $connections[] = $connection;
        }
        return $connections;
    }

    /** @param list<array{0: string, 1: string}> $pairs */
    private static function singleParameter(array $pairs, string $name): string
    {
        $values = [];
        foreach ($pairs as [$key, $value]) {
            if ($key === $name) {
                $values[] = $value;
            }
        }
        if (count($values) !== 1) {
            throw new \InvalidArgumentException("LSC URI requires exactly one {$name} parameter.");
        }
        return $values[0];
    }

    private static function credential(mixed $value, string $label, int $maximumLength): string
    {
        $normalized = trim(is_scalar($value) ? (string) $value : '');
        if ($normalized === '') {
            throw new \InvalidArgumentException("{$label} must not be empty.");
        }
        if (strlen($normalized) > $maximumLength) {
            throw new \InvalidArgumentException("{$label} is too long.");
        }
        return $normalized;
    }

    private static function normalizePath(string $path): string
    {
        if ($path === '' || $path === '/') {
            return '/';
        }
        return str_ends_with($path, '/') ? $path : "{$path}/";
    }

    private static function providerId(string $host, ?int $port, string $path): string
    {
        $segments = array_filter(explode('/', $path), static fn (string $segment): bool => $segment !== '');
        $joined = implode('-', $segments);
        $raw = strtolower($host . ($port === null ? '' : "-{$port}") . ($joined === '' ? '' : "-{$joined}"));
        $raw = preg_replace('/[^a-z0-9_-]+/', '-', $raw) ?? $raw;
        $raw = substr(trim($raw, '-'), 0, 64);
        if ($raw === '') {
            throw new \InvalidArgumentException('LSC URI could not derive a provider id.');
        }
        return $raw;
    }
}
