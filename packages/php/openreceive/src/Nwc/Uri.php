<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

use OpenReceive\Kernel;

/**
 * NWC connection-string parsing and redaction. Mirrors the JS parseNwcUri: the
 * same error codes for the same failures, so every engine passes the shared
 * nwc-uri-parse vectors. The parsed secret never leaves the server; `redacted`
 * is the only form that may be logged.
 */
final class Uri
{
    public const SCHEME = 'nostr+walletconnect';

    /**
     * @return array{wallet_pubkey: string, relays: list<string>, client_secret: string, redacted: string, lud16?: string}
     */
    public static function parse(mixed $uri): array
    {
        if (!is_string($uri) || trim($uri) === '') {
            throw new NwcUriParseError('invalid_uri', 'Invalid NWC URI.', null);
        }
        $parts = parse_url($uri);
        if ($parts === false) {
            throw new NwcUriParseError('invalid_uri', 'Invalid NWC URI.', $uri);
        }
        if (($parts['scheme'] ?? null) !== self::SCHEME) {
            throw new NwcUriParseError('invalid_scheme', 'NWC URI must use nostr+walletconnect.', $uri);
        }
        // Both forms are accepted: `nostr+walletconnect://<pubkey>?…` (host) and
        // the opaque `nostr+walletconnect:<pubkey>?…` (path), like JS and Ruby.
        $wallet = (string) ($parts['host'] ?? '');
        if ($wallet === '') {
            $wallet = ltrim((string) ($parts['path'] ?? ''), '/');
        }
        if ($wallet === '') {
            throw new NwcUriParseError('missing_wallet_pubkey', 'NWC URI is missing the wallet public key.', $uri);
        }
        if (preg_match(Kernel::HEX_64_PATTERN, $wallet) !== 1) {
            throw new NwcUriParseError('invalid_wallet_pubkey', 'NWC wallet public key must be 64 hex characters.', $uri);
        }
        $pairs = self::decodeQuery((string) ($parts['query'] ?? ''));
        $relays = [];
        $secrets = [];
        $lud16 = null;
        foreach ($pairs as [$key, $value]) {
            if ($key === 'relay') {
                $relays[] = $value;
            } elseif ($key === 'secret') {
                $secrets[] = $value;
            } elseif ($key === 'lud16' && $lud16 === null) {
                $lud16 = $value;
            }
        }
        if ($relays === []) {
            throw new NwcUriParseError('missing_relay', 'NWC URI must include at least one relay.', $uri);
        }
        foreach ($relays as $relay) {
            if (!self::isValidRelayUrl($relay)) {
                throw new NwcUriParseError('invalid_relay', 'NWC relay URLs must be valid wss URLs.', $uri);
            }
        }
        if ($secrets === [] || $secrets[0] === '') {
            throw new NwcUriParseError('missing_secret', 'NWC URI is missing the client secret.', $uri);
        }
        if (count($secrets) !== 1 || preg_match(Kernel::HEX_64_PATTERN, $secrets[0]) !== 1) {
            throw new NwcUriParseError('invalid_secret', 'NWC client secret must be 64 hex characters.', $uri);
        }
        $result = [
            'wallet_pubkey' => $wallet,
            'relays' => $relays,
            'client_secret' => $secrets[0],
            'redacted' => self::redact($uri),
        ];
        if ($lud16 !== null && $lud16 !== '') {
            $result['lud16'] = $lud16;
        }
        return $result;
    }

    /**
     * Redacts every query pair whose PERCENT-DECODED key is "secret" (so
     * `%73ecret=` cannot slip past). Other pairs keep their original bytes.
     */
    public static function redact(string $uri): string
    {
        $queryStart = strpos($uri, '?');
        if ($queryStart === false) {
            return $uri;
        }
        $fragmentStart = strpos($uri, '#', $queryStart + 1);
        $queryEnd = $fragmentStart === false ? strlen($uri) : $fragmentStart;
        $query = substr($uri, $queryStart + 1, $queryEnd - $queryStart - 1);
        $redacted = [];
        foreach (explode('&', $query) as $pair) {
            $separator = strpos($pair, '=');
            $key = $separator === false ? $pair : substr($pair, 0, $separator);
            $decodedKey = urldecode($key);
            $redacted[] = strtolower($decodedKey) === 'secret' && $separator !== false ? "{$key}=[REDACTED]" : $pair;
        }
        return substr($uri, 0, $queryStart + 1) . implode('&', $redacted) . substr($uri, $queryEnd);
    }

    public static function isValidRelayUrl(string $relay): bool
    {
        $parts = parse_url($relay);
        return $parts !== false && ($parts['scheme'] ?? null) === 'wss' && ($parts['host'] ?? '') !== '';
    }

    /**
     * application/x-www-form-urlencoded pairs, duplicates preserved in order.
     *
     * @return list<array{0: string, 1: string}>
     */
    private static function decodeQuery(string $query): array
    {
        if ($query === '') {
            return [];
        }
        $pairs = [];
        foreach (explode('&', $query) as $pair) {
            if ($pair === '') {
                continue;
            }
            $separator = strpos($pair, '=');
            $key = $separator === false ? $pair : substr($pair, 0, $separator);
            $value = $separator === false ? '' : substr($pair, $separator + 1);
            $pairs[] = [urldecode($key), urldecode($value)];
        }
        return $pairs;
    }
}
