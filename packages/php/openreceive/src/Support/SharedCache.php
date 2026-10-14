<?php

declare(strict_types=1);

namespace OpenReceive\Support;

/**
 * A host cache that outlives one request: the swap provider's currency list
 * and rates, the BTC price feed, and the wallet's info event (the methods and
 * encryption modes the preflight reads).
 *
 * PHP builds the engine again on every request, so process memory lasts one
 * request. Without a shared cache every checkout route fetches those again,
 * which costs each route 0.5–1.5 s. Laravel passes its default cache store,
 * WordPress its transients, and `Service::fromEnvironment()` a FileSharedCache
 * when the app passes none. Connection codes, payments and swap credentials
 * never go here. The engine treats a throw from either method as a cache miss.
 */
interface SharedCache
{
    /** The stored value, or null when it is absent or expired. */
    public function get(string $key): ?string;

    public function set(string $key, string $value, int $ttlSeconds): void;
}
