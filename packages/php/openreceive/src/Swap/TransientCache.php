<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

use Psr\Log\LoggerInterface;

/**
 * A disposable, process-local provider catalog/rate cache with no storage
 * adapter (the JS limits-cache.ts). PHP requests are single-threaded, so the
 * in-flight coalescing the Node/Ruby twins carry collapses to the state
 * machine alone: fresh → serve; recently failed → stale-or-raise; otherwise
 * fetch, store, and on failure keep the previous value for stale service.
 */
final class TransientCache
{
    public const MAX_STALE_SECONDS = 48 * 60 * 60;
    public const REFRESH_CLAIM_SECONDS = 60;

    /** @var callable(): int */
    private $clock;
    /** @var array<string, array{value?: string, fetched_at?: int, failed_at?: int, error?: string}> */
    private array $states = [];

    /** @param callable(): int $clock */
    public function __construct(callable $clock, private readonly ?LoggerInterface $logger = null)
    {
        $this->clock = $clock;
    }

    public static function limitsMetaKey(string $providerName): string
    {
        return "swap_limits:{$providerName}";
    }

    /**
     * @template T
     * @param callable(): T $fetch
     * @param callable(T): string $serialize
     * @param callable(string): T $deserialize
     * @return T
     */
    public function resolve(
        string $key,
        int $refreshSeconds,
        int $maxStaleSeconds,
        callable $fetch,
        callable $serialize,
        callable $deserialize,
        int $claimSeconds = self::REFRESH_CLAIM_SECONDS,
        bool $serveStaleOnFailure = true,
    ): mixed {
        $now = ($this->clock)();
        $state = $this->states[$key] ?? null;
        if ($state !== null && isset($state['value'], $state['fetched_at']) && $now - $state['fetched_at'] < $refreshSeconds) {
            return $deserialize($state['value']);
        }
        if ($state !== null && isset($state['failed_at']) && $now - $state['failed_at'] < $claimSeconds) {
            return $this->staleOrRaise($key, $state, $now, $maxStaleSeconds, $serveStaleOnFailure, $deserialize, null);
        }
        try {
            $value = $fetch();
            $this->states[$key] = ['value' => $serialize($value), 'fetched_at' => $now];
            return $value;
        } catch (\Throwable $e) {
            $failed = ['failed_at' => $now, 'error' => $e->getMessage()];
            if ($state !== null && isset($state['value'], $state['fetched_at'])) {
                $failed['value'] = $state['value'];
                $failed['fetched_at'] = $state['fetched_at'];
            }
            $this->states[$key] = $failed;
            return $this->staleOrRaise($key, $failed, $now, $maxStaleSeconds, $serveStaleOnFailure, $deserialize, $e);
        }
    }

    /**
     * @param array{value?: string, fetched_at?: int, failed_at?: int, error?: string} $state
     * @param callable(string): mixed $deserialize
     */
    private function staleOrRaise(string $key, array $state, int $now, int $maxStaleSeconds, bool $serveStaleOnFailure, callable $deserialize, ?\Throwable $cause): mixed
    {
        if ($serveStaleOnFailure && isset($state['value'], $state['fetched_at']) && $now - $state['fetched_at'] < $maxStaleSeconds) {
            $this->logger?->warning('Serving stale swap provider data after refresh failed.', ['key' => $key, 'error' => $state['error'] ?? null]);
            return $deserialize($state['value']);
        }
        if ($cause !== null) {
            throw $cause;
        }
        throw new \RuntimeException($state['error'] ?? 'Swap provider cache refresh failed.');
    }
}
