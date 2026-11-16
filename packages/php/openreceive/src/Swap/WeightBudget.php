<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

use OpenReceive\Support\SharedCache;
use Psr\Log\LoggerInterface;

/**
 * A disposable per-process request guard for one provider's API; the provider
 * remains the global rate-limit authority. Port of the JS weight-budget.ts.
 * It is sized by the provider's limits (SwapProviderLimits; the FixedFloat
 * ones when none are given). The 60 s window rolls; a 429 stand-off expires
 * on its own clock and does NOT ride along with the window.
 *
 * The counts and the window are this object's memory and nothing else. PHP
 * builds the service again for every request, so each request starts with
 * fresh counts: they are never shared, because a shared count would be a
 * site-wide limit of this library's own.
 *
 * The provider's 429 is different: it says "wait", and the next request has
 * to hear it. Given a SharedCache, the guard keeps the two stand-off end
 * times there (and only those), so a later request refuses the call the
 * provider just refused instead of asking again. Without a shared cache, or
 * when it fails, a stand-off ends with the process that was told to wait.
 */
final class WeightBudget
{
    public const WINDOW_SECONDS = 60;
    public const SOFT_CAP = 200;
    public const CREATE_GATE = 150;
    public const CREATE_WEIGHT = 50;
    public const DEFAULT_WEIGHT = 1;
    public const BACKOFF_SECONDS = 60;
    /** The shared entry outlives the stand-off by this much: a cache that counts in whole seconds must not drop it early. */
    public const SHARED_TTL_MARGIN_SECONDS = 1;

    /** @var callable(): int */
    private $clock;
    private readonly SwapProviderLimits $limits;
    private int $windowStart;
    private int $used = 0;
    private int $creates = 0;
    private ?int $backoffUntil = null;
    private ?int $createBackoffUntil = null;

    /**
     * @param callable(): int $clock
     * @param SharedCache|null $shared where a 429 stand-off is kept for the requests that follow; null keeps it in this process
     */
    public function __construct(
        private readonly string $providerId,
        callable $clock,
        ?SwapProviderLimits $limits = null,
        private readonly ?SharedCache $shared = null,
        private readonly ?LoggerInterface $logger = null,
    ) {
        $this->clock = $clock;
        $this->limits = $limits ?? SwapProviderLimits::fixedFloat();
        $this->windowStart = $clock();
    }

    /** The SharedCache key one provider's stand-off is kept under (next to its `swap_limits:` and `swap_rates:` entries). */
    public static function sharedKey(string $providerId): string
    {
        return TransientCache::SHARED_KEY_PREFIX . "swap_backoff:{$providerId}";
    }

    public function limits(): SwapProviderLimits
    {
        return $this->limits;
    }

    public function weightForPath(string $path): int
    {
        return $path === 'create' ? $this->limits->createWeight : $this->limits->defaultWeight;
    }

    /**
     * Throw the same denial `reserve` would, without using any budget. Lets a
     * caller refuse a new swap before it does any other work for it.
     *
     * @throws WeightBudgetError
     */
    public function assertAvailable(string $path): void
    {
        $this->rollWindow();
        $now = ($this->clock)();
        $cost = $this->weightForPath($path);
        $gate = $path === 'create' ? $this->limits->createGate : $this->limits->softCap;
        $backoffUntil = $this->activeBackoff($path, $now);
        if ($backoffUntil !== null) {
            $this->deny($path, 'backoff', $cost, $gate, "Swap provider API is in backoff until {$backoffUntil}.", $backoffUntil);
        }
        if ($this->used + $cost > $gate) {
            $this->deny($path, 'exhausted', $cost, $gate, "Swap provider API weight budget exhausted ({$this->used}+{$cost} > {$gate}).");
        }
        $createLimit = $this->limits->createLimit;
        if ($path === 'create' && $createLimit !== null && $this->creates + 1 > $createLimit) {
            $this->deny($path, 'exhausted', $cost, $gate, "Swap provider create budget exhausted ({$this->creates}+1 > {$createLimit}).");
        }
    }

    /** @throws WeightBudgetError */
    public function reserve(string $path): void
    {
        $this->assertAvailable($path);
        $this->used += $this->weightForPath($path);
        if ($path === 'create') {
            $this->creates++;
        }
    }

    /**
     * The provider answered 429 on `$path`. `$retryAfterSeconds` is the
     * provider's own wait (from `Retry-After` or its response body); null,
     * or anything that is not a positive number, means it named none.
     */
    public function markRateLimited(?string $path = null, int|float|null $retryAfterSeconds = null): void
    {
        $now = ($this->clock)();
        $until = $now + $this->backoffSeconds($retryAfterSeconds);
        if ($this->limits->createBackoffOnly && $path === 'create') {
            $this->createBackoffUntil = max($this->createBackoffUntil ?? 0, $until);
            $this->shareBackoffs($now);
            return;
        }
        $this->backoffUntil = max($this->backoffUntil ?? 0, $until);
        // The provider's own window is spent until then and fresh after it, so
        // this guard's window restarts when the stand-off ends. Keeping the old
        // count would go on refusing calls the provider has started accepting.
        $this->windowStart = $this->backoffUntil;
        $this->used = 0;
        $this->creates = 0;
        $this->shareBackoffs($now);
    }

    private function backoffSeconds(int|float|null $retryAfterSeconds): int
    {
        if ($retryAfterSeconds === null || !is_finite((float) $retryAfterSeconds) || $retryAfterSeconds <= 0) {
            return $this->limits->backoffSeconds;
        }
        // Clamped before the cast: a wait too large for an integer is still just "the longest stand-off".
        return (int) min(max(ceil((float) $retryAfterSeconds), (float) $this->limits->minBackoffSeconds), (float) $this->limits->maxBackoffSeconds);
    }

    /** The stand-off `$path` is under, if any: the later of what this process was told and what another request shared. */
    private function activeBackoff(string $path, int $now): ?int
    {
        $shared = $this->sharedBackoffs($now);
        $backoffUntil = max($this->backoffUntil ?? 0, $shared['backoff_until'] ?? 0);
        if ($backoffUntil > $now) {
            return $backoffUntil;
        }
        $createBackoffUntil = max($this->createBackoffUntil ?? 0, $shared['create_backoff_until'] ?? 0);
        if ($path === 'create' && $createBackoffUntil > $now) {
            return $createBackoffUntil;
        }
        return null;
    }

    /**
     * The stand-offs another request left in the shared cache that are still
     * running. Everything else is no stand-off at all: no cache, a cache that
     * throws, an entry that is not ours, an end time that has passed. So is an
     * end time further away than this provider's longest stand-off: a skewed
     * clock or a damaged entry must not switch swaps off.
     *
     * @return array{backoff_until?: int, create_backoff_until?: int}
     */
    private function sharedBackoffs(int $now): array
    {
        if ($this->shared === null) {
            return [];
        }
        try {
            $stored = $this->shared->get(self::sharedKey($this->providerId));
        } catch (\Throwable $e) {
            $this->logger?->debug('[openreceive] shared cache read failed; a swap provider stand-off is not shared: ' . $e::class);
            return [];
        }
        $entry = $stored === null ? null : json_decode($stored, true);
        if (!is_array($entry)) {
            return [];
        }
        $running = [];
        foreach (['backoff_until', 'create_backoff_until'] as $field) {
            $until = $entry[$field] ?? null;
            if (is_int($until) && $until > $now && $until - $now <= $this->limits->maxBackoffSeconds) {
                $running[$field] = $until;
            }
        }
        return $running;
    }

    /**
     * Leave the running stand-offs where the next request will find them:
     * only the two end times, never the counts or the window. The entry is
     * merged with what is already there, so a later, shorter 429 never
     * shortens a stand-off another request stored, and it expires when the
     * last stand-off ends. A write that fails changes nothing for this process.
     */
    private function shareBackoffs(int $now): void
    {
        if ($this->shared === null) {
            return;
        }
        $shared = $this->sharedBackoffs($now);
        $entry = array_filter([
            'backoff_until' => max($this->backoffUntil ?? 0, $shared['backoff_until'] ?? 0),
            'create_backoff_until' => max($this->createBackoffUntil ?? 0, $shared['create_backoff_until'] ?? 0),
        ], static fn (int $until): bool => $until > $now);
        if ($entry === []) {
            return;
        }
        try {
            $this->shared->set(
                self::sharedKey($this->providerId),
                json_encode($entry, JSON_THROW_ON_ERROR),
                max($entry) - $now + self::SHARED_TTL_MARGIN_SECONDS,
            );
        } catch (\Throwable $e) {
            $this->logger?->debug('[openreceive] shared cache write failed; a swap provider stand-off is not shared: ' . $e::class);
        }
    }

    // The window rolls; the 429 stand-off does NOT ride along with it. Clearing
    // it here cut a stand-off arbitrarily short, so it expires on its own
    // clock, checked in assertAvailable().
    private function rollWindow(): void
    {
        $now = ($this->clock)();
        if ($now - $this->windowStart < self::WINDOW_SECONDS) {
            return;
        }
        $this->windowStart = $now;
        $this->used = 0;
        $this->creates = 0;
    }

    private function deny(string $path, string $reason, int $cost, int $gate, string $message, ?int $backoffUntil = null): never
    {
        $denial = [
            'provider' => $this->providerId, 'path' => $path, 'reason' => $reason, 'message' => $message,
            'used' => $this->used, 'cost' => $cost, 'gate' => $gate, 'window_start' => $this->windowStart,
        ];
        $until = $backoffUntil ?? $this->backoffUntil;
        if ($until !== null) {
            $denial['backoff_until'] = $until;
        }
        if ($this->limits->createLimit !== null) {
            $denial['creates'] = $this->creates;
            $denial['create_limit'] = $this->limits->createLimit;
        }
        throw new WeightBudgetError($message, $denial);
    }
}
