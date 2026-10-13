<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Cache;

use Illuminate\Contracts\Cache\Repository;
use OpenReceive\Support\SharedCache;

/**
 * The engine's SharedCache over the app's default cache store. PHP builds the
 * engine again on every request; this keeps the swap provider's catalog and
 * rates and the BTC price between requests, so a checkout route does not
 * fetch them again each time. The engine treats a store failure as a miss.
 */
final class AppSharedCache implements SharedCache
{
    public function __construct(private readonly Repository $store)
    {
    }

    public function get(string $key): ?string
    {
        $value = $this->store->get($key);
        return is_string($value) ? $value : null;
    }

    public function set(string $key, string $value, int $ttlSeconds): void
    {
        $this->store->put($key, $value, $ttlSeconds);
    }
}
