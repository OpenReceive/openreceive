<?php
declare(strict_types=1);
namespace OpenReceive\WP;

use OpenReceive\Nwc\Errors;

/** The admin form and CLI share the same validate-before-save path. */
final class Configuration
{
    public static function save(array $settings): void
    {
        $env = Secrets::environment($settings);
        if (($settings['enabled'] ?? 'no') === 'yes' || $env['NWC_URI'] !== '') {
            Plugin::service($settings);
        }
        update_option('woocommerce_openreceive_settings', $settings, false);
        Plugin::resetEngine();
    }

    public static function withSecret(array $settings, string $field, string $value): array
    {
        if (!isset(Secrets::FIELDS[$field])) { throw new \InvalidArgumentException('Unknown credential field.'); }
        if (defined('OPENRECEIVE_' . Secrets::FIELDS[$field])) {
            throw new \RuntimeException(esc_html(Secrets::FIELDS[$field]) . ' is controlled by wp-config.php; update that server configuration instead.');
        }
        $value = trim($value);
        if ($value === '') { throw new \InvalidArgumentException('No credential was read from stdin. Existing settings were preserved.'); }
        $settings[$field] = Secrets::encrypt($value);
        return $settings;
    }

    public static function errorMessage(\Throwable $error, array $values = []): string
    {
        try { $values = [...$values, ...array_values(Secrets::environment())]; } catch (\Throwable) { /* Decryption errors have no credential text. */ }
        $message = $error->getMessage();
        foreach ($values as $value) {
            if (is_string($value) && strlen($value) > 4) { $message = str_replace($value, '[REDACTED]', $message); }
        }
        return Errors::redactErrorText($message);
    }

    public static function title(array $settings): string
    {
        $title = (string) ($settings['title'] ?? '');
        // A saved earlier default ("Bitcoin & crypto" until 0.4.17) is still a default, not a custom title.
        if ($title !== '' && !in_array($title, ['Bitcoin Lightning (OpenReceive)', 'Bitcoin & crypto (OpenReceive)', 'Bitcoin & stablecoins (OpenReceive)'], true)) { return $title; }
        try {
            $env = Secrets::environment($settings);
            if ($env['LSC_URI_PRIMARY'] !== '' || $env['LSC_URI_BACKUP'] !== '') { return __('Bitcoin & stablecoins (OpenReceive)', 'openreceive'); }
        } catch (\Throwable) { /* Doctor reports invalid settings. */ }
        return __('Bitcoin Lightning (OpenReceive)', 'openreceive');
    }
}
