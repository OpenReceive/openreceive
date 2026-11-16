<?php

declare(strict_types=1);

namespace OpenReceive\Server;

/**
 * Client-IP bucketing shared by rate limiting and attempt-row stamping; ports
 * the JS clientIpBucket exactly. IPv4-mapped IPv6 collapses to the IPv4; IPv6
 * buckets to its /64 (privacy extensions rotate the low bits); IPv4 and
 * already-bucketed values pass through; unparsable input passes through as-is
 * so an odd value still gets SOME consistent bucket.
 */
final class ClientIp
{
    /** No attributable IP stays null (the limiter fails open); anything else is normalized into the stored and counted bucket. */
    public static function attributed(mixed $raw): ?string
    {
        $value = is_scalar($raw) ? (string) $raw : '';
        return trim($value) === '' ? null : self::bucket($value);
    }

    public static function bucket(string $ip): string
    {
        $value = strtolower(trim($ip));
        if (str_starts_with($value, '::ffff:') && str_contains($value, '.')) {
            $value = substr($value, strlen('::ffff:'));
        }
        if (!str_contains($value, ':') || str_ends_with($value, '/64')) {
            return $value;
        }
        $address = explode('%', $value, 2)[0];
        $hextets = self::expandIpv6($address);
        if ($hextets === null) {
            return $value;
        }
        return implode(':', array_slice($hextets, 0, 4)) . '::/64';
    }

    /**
     * Whether the limiter may count this client value as one payer; ports the
     * JS isPayerAddress (the rate-limit-address vector).
     *
     * False for an IP address no payer on the internet can have: loopback,
     * private (RFC 1918), carrier-shared (100.64.0.0/10), link-local, the
     * unspecified address, and their IPv6 counterparts (::1, fc00::/7,
     * fe80::/10). A server sees one of those only when the request came from
     * its own proxy or network, so the address stands for every payer at once.
     *
     * True for every other IP, and for a value that is not an IP at all: a
     * host that passes its own identifier (an account id, a session key)
     * chose it deliberately. Accepts raw addresses and the buckets `bucket()`
     * returns.
     */
    public static function isPayer(string $value): bool
    {
        $address = strtolower(trim($value));
        if (str_starts_with($address, '::ffff:') && str_contains($address, '.')) {
            $address = substr($address, strlen('::ffff:'));
        }
        if (!str_contains($address, ':')) {
            if (preg_match('/\A\d{1,3}(\.\d{1,3}){3}\z/', $address) !== 1) {
                return true;
            }
            [$a, $b, $c, $d] = array_map('intval', explode('.', $address));
            if (max($a, $b, $c, $d) > 255) {
                return true;
            }
            return !($a === 0
                || $a === 10
                || $a === 127
                || ($a === 100 && $b >= 64 && $b <= 127)
                || ($a === 169 && $b === 254)
                || ($a === 172 && $b >= 16 && $b <= 31)
                || ($a === 192 && $b === 168));
        }
        $withoutZone = explode('%', $address, 2)[0];
        $hextets = self::expandIpv6(str_ends_with($withoutZone, '/64') ? substr($withoutZone, 0, -3) : $withoutZone);
        if ($hextets === null) {
            return true;
        }
        // :: and ::1 (a /64 bucket of either is all zeros in its first four groups).
        if (array_slice($hextets, 0, 7) === array_fill(0, 7, '0') && in_array($hextets[7] ?? '', ['0', '1'], true)) {
            return false;
        }
        $first = (int) hexdec($hextets[0]);
        return !(($first & 0xfe00) === 0xfc00 || ($first & 0xffc0) === 0xfe80);
    }

    /** @return list<string>|null */
    private static function expandIpv6(string $value): ?array
    {
        if ($value === '') {
            return null;
        }
        $parts = explode('::', $value);
        if (count($parts) > 2) {
            return null;
        }
        $head = self::hextetsOf($parts[0]);
        $tail = count($parts) === 2 ? self::hextetsOf($parts[1]) : [];
        if ($head === null || $tail === null) {
            return null;
        }
        if (count($parts) === 1) {
            return count($head) === 8 ? $head : null;
        }
        $missing = 8 - count($head) - count($tail);
        if ($missing < 1) {
            return null;
        }
        return [...$head, ...array_fill(0, $missing, '0'), ...$tail];
    }

    /** @return list<string>|null */
    private static function hextetsOf(string $segment): ?array
    {
        if ($segment === '') {
            return [];
        }
        $groups = [];
        foreach (explode(':', $segment) as $group) {
            if (preg_match('/\A[0-9a-f]{1,4}\z/', $group) === 1) {
                $groups[] = ltrim($group, '0') === '' ? '0' : ltrim($group, '0');
            } elseif (preg_match('/\A\d{1,3}(\.\d{1,3}){3}\z/', $group) === 1) {
                $octets = array_map('intval', explode('.', $group));
                if (max($octets) > 255) {
                    return null;
                }
                // Embedded IPv4 tail expands to two hextets.
                $groups[] = dechex(($octets[0] << 8) | $octets[1]);
                $groups[] = dechex(($octets[2] << 8) | $octets[3]);
            } else {
                return null;
            }
        }
        return $groups;
    }
}
