<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop;

\defined('_JEXEC') or die;

/**
 * The wallet and swap codes at rest: sealed with sodium's secretbox under a
 * key derived from the site's own secret (configuration.php's $secret), so
 * the plugin's row in the database alone never reveals them. Pure, so it is
 * tested without Joomla.
 */
final class Codes
{
    private const VERSION = 'v1:';

    public static function seal(string $plain, string $siteSecret): string
    {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        return self::VERSION . base64_encode($nonce . sodium_crypto_secretbox($plain, $nonce, self::key($siteSecret)));
    }

    /** The code, or null when the value was sealed under another site secret or is not a sealed value. */
    public static function open(string $sealed, string $siteSecret): ?string
    {
        if (!str_starts_with($sealed, self::VERSION)) {
            return null;
        }
        $raw = base64_decode(substr($sealed, strlen(self::VERSION)), true);
        if (!is_string($raw) || strlen($raw) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES) {
            return null;
        }
        $plain = sodium_crypto_secretbox_open(
            substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES),
            substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES),
            self::key($siteSecret),
        );
        return is_string($plain) ? $plain : null;
    }

    private static function key(string $siteSecret): string
    {
        if ($siteSecret === '') {
            throw new \RuntimeException('This site has no secret in configuration.php, so OpenReceive cannot keep its codes encrypted.');
        }
        return hash_hmac('sha256', 'OpenReceive HikaShop codes', $siteSecret, true);
    }
}
