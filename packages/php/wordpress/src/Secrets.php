<?php
declare(strict_types=1);
namespace OpenReceive\WP;

final class Secrets
{
    public const FIELDS = ['nwc_uri' => 'NWC_URI', 'lsc_uri_primary' => 'LSC_URI_PRIMARY', 'lsc_uri_backup' => 'LSC_URI_BACKUP'];

    private static function key(): string
    {
        return hash_hkdf('sha256', AUTH_KEY . SECURE_AUTH_KEY, SODIUM_CRYPTO_SECRETBOX_KEYBYTES, 'openreceive-settings-v1');
    }

    public static function encrypt(string $value): string
    {
        if ($value === '') { return ''; }
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        return base64_encode($nonce . sodium_crypto_secretbox($value, $nonce, self::key()));
    }

    public static function decrypt(string $value): string
    {
        if ($value === '') { return ''; }
        $raw = base64_decode($value, true);
        if ($raw === false || strlen($raw) < SODIUM_CRYPTO_SECRETBOX_NONCEBYTES + SODIUM_CRYPTO_SECRETBOX_MACBYTES) {
            throw new \RuntimeException('Re-enter the OpenReceive credentials.');
        }
        $plain = sodium_crypto_secretbox_open(substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), self::key());
        if ($plain === false) { throw new \RuntimeException('OpenReceive credentials cannot be decrypted; re-enter them after changing WordPress keys.'); }
        return $plain;
    }

    public static function environment(?array $settings = null): array
    {
        $settings ??= get_option('woocommerce_openreceive_settings', []);
        $env = [];
        foreach (self::FIELDS as $field => $name) {
            $constant = 'OPENRECEIVE_' . $name;
            $env[$name] = defined($constant) ? (string) constant($constant) : self::decrypt((string) ($settings[$field] ?? ''));
        }
        $env['OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC'] = defined('OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC')
            ? (OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC ? '1' : '0') : (($settings['allow_spend'] ?? 'no') === 'yes' ? '1' : '0');
        return $env;
    }
}
