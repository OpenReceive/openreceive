<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive\Support;

use Illuminate\Contracts\Cache\Repository;
use OpenReceive\Support\SharedCache;

/**
 * The engine's SharedCache over Paymenter's cache store: the wallet's info
 * event, the BTC price and the swap provider's catalog and rates. Codes,
 * payments and swap credentials never go here. The engine treats a store
 * failure as a miss.
 */
final class LaravelCache implements SharedCache
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
