<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

use OpenReceive\Support\SharedCache;
use Psr\Log\LoggerInterface;

/**
 * The wallet client with its info event remembered in a SharedCache.
 *
 * PHP builds the whole engine again on every request, and the Service runs
 * the receive-only preflight (`get_info`) at construction, so without this
 * every OpenReceive request pays a relay round trip (about 0.5 s) before its
 * own work. The capability list changes only when the merchant re-issues the
 * connection, and the key names the connection code, so a new code always
 * asks the wallet. The inner client is primed from the cached info and picks
 * its encryption mode exactly as a live preflight would. A cache failure
 * falls back to the live preflight.
 */
final class CachedWalletInfo implements ReceiveNwcClient
{
    public const TTL_SECONDS = 600;

    public function __construct(
        private readonly NostrPhpNwcReceiveClient $inner,
        private readonly SharedCache $cache,
        private readonly string $cacheKey,
        private readonly int $ttlSeconds = self::TTL_SECONDS,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /** The cache key for a connection code: a hash, so the code itself never reaches the cache. */
    public static function keyFor(string $connectionUri): string
    {
        return 'openreceive:wallet_info:' . hash('sha256', trim($connectionUri));
    }

    public function preflight(): array
    {
        $cached = $this->read();
        if ($cached !== null) {
            $this->inner->primeInfo($cached);
            return $cached;
        }
        $info = $this->inner->preflight();
        try {
            $this->cache->set($this->cacheKey, json_encode($info, JSON_THROW_ON_ERROR), $this->ttlSeconds);
        } catch (\Throwable $e) {
            $this->logger?->debug('[openreceive] wallet info cache write failed; the next request will ask the wallet again: ' . $e::class);
        }
        return $info;
    }

    public function makeInvoice(array $request): array
    {
        return $this->inner->makeInvoice($request);
    }

    public function listTransactions(array $request): array
    {
        return $this->inner->listTransactions($request);
    }

    public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
    {
        $this->inner->subscribeNotifications($handler, $onIdle);
    }

    public function stopNotifications(): void
    {
        $this->inner->stopNotifications();
    }

    /** @return array<string, mixed>|null */
    private function read(): ?array
    {
        try {
            $stored = $this->cache->get($this->cacheKey);
        } catch (\Throwable $e) {
            $this->logger?->debug('[openreceive] wallet info cache read failed; asking the wallet: ' . $e::class);
            return null;
        }
        $info = $stored === null ? null : json_decode($stored, true);
        return is_array($info) ? $info : null;
    }
}
