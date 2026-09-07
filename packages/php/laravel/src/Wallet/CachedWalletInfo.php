<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Wallet;

use Illuminate\Contracts\Cache\Repository;
use OpenReceive\Nwc\NostrPhpNwcReceiveClient;
use OpenReceive\Nwc\ReceiveNwcClient;
use Psr\Log\LoggerInterface;

/**
 * The wallet client with its info event remembered in Laravel's cache.
 *
 * PHP builds the whole engine again on every request, and the Service runs
 * the receive-only preflight (`get_info`) at construction — so without this
 * every OpenReceive request under FPM or Apache would pay a relay round trip
 * before doing its own work. The capability summary changes only when the
 * merchant re-issues the connection, so it is cached for a short TTL; the
 * inner client is primed from it and chooses its encryption mode exactly as a
 * live preflight would. A cache failure degrades to the live preflight.
 */
final class CachedWalletInfo implements ReceiveNwcClient
{
    public function __construct(
        private readonly ReceiveNwcClient $inner,
        private readonly Repository $cache,
        private readonly string $cacheKey,
        private readonly int $ttlSeconds,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    public static function keyFor(NostrPhpNwcReceiveClient $client): string
    {
        return 'openreceive:wallet-info:' . sha1(json_encode($client->connectionSummary(), JSON_THROW_ON_ERROR));
    }

    public function preflight(): array
    {
        if ($this->ttlSeconds > 0) {
            $cached = $this->read();
            if ($cached !== null) {
                if ($this->inner instanceof NostrPhpNwcReceiveClient) {
                    $this->inner->primeInfo($cached);
                }
                return $cached;
            }
        }
        $info = $this->inner->preflight();
        if ($this->ttlSeconds > 0) {
            try {
                $this->cache->put($this->cacheKey, $info, $this->ttlSeconds);
            } catch (\Throwable $e) {
                $this->logger?->debug('[openreceive] wallet info cache write failed; every request will preflight: ' . $e::class);
            }
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

    /** @return array<string, mixed>|null */
    private function read(): ?array
    {
        try {
            $cached = $this->cache->get($this->cacheKey);
        } catch (\Throwable $e) {
            $this->logger?->debug('[openreceive] wallet info cache read failed; running the live preflight: ' . $e::class);
            return null;
        }
        return is_array($cached) ? $cached : null;
    }
}
