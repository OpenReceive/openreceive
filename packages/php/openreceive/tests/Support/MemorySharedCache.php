<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Support;

use OpenReceive\Support\SharedCache;

/** One store that several engines share, the way requests share Laravel's cache. */
final class MemorySharedCache implements SharedCache
{
    /** @var array<string, array{value: string, ttl: int}> */
    public array $entries = [];

    public function get(string $key): ?string
    {
        return $this->entries[$key]['value'] ?? null;
    }

    public function set(string $key, string $value, int $ttlSeconds): void
    {
        $this->entries[$key] = ['value' => $value, 'ttl' => $ttlSeconds];
    }
}
