<?php
declare(strict_types=1);
namespace OpenReceive\WP;
defined('ABSPATH') || exit;

use OpenReceive\Support\SharedCache;

/**
 * The engine's SharedCache over transients. PHP builds the engine again on
 * every request, so without it each checkout call fetches the BTC price and
 * the swap provider's catalog and rates again.
 */
final class WpTransientsCache implements SharedCache
{
    public function get(string $key): ?string
    {
        $value = get_transient($key);
        return is_string($value) ? $value : null;
    }

    public function set(string $key, string $value, int $ttlSeconds): void
    {
        set_transient($key, $value, $ttlSeconds);
    }
}
