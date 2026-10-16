<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Support;

use OpenReceive\Support\SharedCache;

/**
 * The engine's SharedCache over FOSSBilling's cache pool: the wallet's info
 * event, the BTC price and the swap provider's catalog and rates. Codes,
 * payments and swap credentials never go here. The engine treats a store
 * failure as a miss.
 */
final class FossbillingCache implements SharedCache
{
    /** @param object $pool FOSSBilling's PSR-6 cache pool */
    public function __construct(private readonly object $pool)
    {
    }

    public function get(string $key): ?string
    {
        $item = $this->pool->getItem(self::key($key));
        $value = $item->isHit() ? $item->get() : null;
        return is_string($value) ? $value : null;
    }

    public function set(string $key, string $value, int $ttlSeconds): void
    {
        $item = $this->pool->getItem(self::key($key));
        $this->pool->save($item->set($value)->expiresAfter($ttlSeconds));
    }

    /** PSR-6 reserves some characters the engine's keys use. */
    private static function key(string $key): string
    {
        return 'openreceive_' . hash('sha256', $key);
    }
}
