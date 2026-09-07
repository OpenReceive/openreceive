<?php

declare(strict_types=1);

namespace ButtonShop;

/**
 * Who this browser is: a SIGNED cookie holding a shop_users.id, and nothing
 * else — no email, no password, no account. Byte-compatible with the Node
 * stacks' cookie.ts: `base64url(value).base64url(hmac_sha256(value, secret))`,
 * one year, rolling, HttpOnly, SameSite=Lax, Secure when the request was TLS.
 *
 * A value someone typed by hand — a uuid copied out of the public feed — fails
 * the signature and reads as absent, which is why the feed can publish
 * `public_ref` and the cookie can carry `id`.
 */
final class Identity
{
    public const COOKIE = 'shop_user_id';
    public const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

    public static function sign(string $value, string $secret): string
    {
        return self::b64($value) . '.' . self::b64(hash_hmac('sha256', $value, $secret, true));
    }

    /** The signed value back, or null for anything that does not verify. */
    public static function read(?string $signed, string $secret): ?string
    {
        if ($signed === null || ($dot = strrpos($signed, '.')) === false || $dot === 0) {
            return null;
        }
        $value = base64_decode(strtr(substr($signed, 0, $dot), '-_', '+/'), true);
        if ($value === false) {
            return null;
        }
        $expected = self::b64(hash_hmac('sha256', $value, $secret, true));
        return hash_equals($expected, substr($signed, $dot + 1)) ? $value : null;
    }

    /** The visitor's private id from a Cookie header, WITHOUT minting one — what `authorize` reads. */
    public static function visitorIdFrom(string $cookieHeader, string $secret): ?string
    {
        return self::read(self::parseCookies($cookieHeader)[self::COOKIE] ?? null, $secret);
    }

    /** @return array<string, string> */
    public static function parseCookies(string $header): array
    {
        $jar = [];
        foreach (explode(';', $header) as $part) {
            $eq = strpos($part, '=');
            if ($eq === false || $eq < 1) {
                continue;
            }
            $name = trim(substr($part, 0, $eq));
            if ($name === '' || isset($jar[$name])) {
                continue;
            }
            $jar[$name] = rawurldecode(trim(substr($part, $eq + 1)));
        }
        return $jar;
    }

    /** The Set-Cookie line. `secure` follows THE REQUEST, not an environment name. */
    public static function setCookie(string $userId, string $secret, bool $secure): string
    {
        $parts = [
            self::COOKIE . '=' . rawurlencode(self::sign($userId, $secret)),
            'Max-Age=' . self::MAX_AGE_SECONDS,
            'Expires=' . gmdate('D, d M Y H:i:s \G\M\T', time() + self::MAX_AGE_SECONDS),
            'Path=/',
            'HttpOnly',
            'SameSite=Lax',
        ];
        if ($secure) {
            $parts[] = 'Secure';
        }
        return implode('; ', $parts);
    }

    /**
     * The app secret: SHOP_COOKIE_SECRET, else one generated on first boot and
     * kept beside the database — a secret regenerated per process would log
     * every visitor out on every restart and turn the persistence demo into a
     * session demo.
     */
    public static function secret(string $dataDir, string $demoId): string
    {
        $fromEnv = getenv('SHOP_COOKIE_SECRET');
        if (is_string($fromEnv) && $fromEnv !== '') {
            return $fromEnv;
        }
        $file = $dataDir . '/' . $demoId . '.secret';
        if (is_file($file)) {
            return trim((string) file_get_contents($file));
        }
        $secret = bin2hex(random_bytes(32));
        file_put_contents($file, $secret . "\n", LOCK_EX);
        chmod($file, 0o600);
        return $secret;
    }

    private static function b64(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }
}
