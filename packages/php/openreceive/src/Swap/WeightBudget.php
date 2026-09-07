<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * A disposable per-process request guard for one provider's API weight; the
 * provider remains the global rate-limit authority. Port of the JS
 * weight-budget.ts. The 60 s window rolls; a 429 backoff expires on its own
 * clock and does NOT ride along with the window.
 */
final class WeightBudget
{
    public const WINDOW_SECONDS = 60;
    public const SOFT_CAP = 200;
    public const CREATE_GATE = 150;
    public const CREATE_WEIGHT = 50;
    public const DEFAULT_WEIGHT = 1;
    public const BACKOFF_SECONDS = 60;

    /** @var callable(): int */
    private $clock;
    private int $windowStart;
    private int $used = 0;
    private ?int $backoffUntil = null;

    /** @param callable(): int $clock */
    public function __construct(private readonly string $providerId, callable $clock)
    {
        $this->clock = $clock;
        $this->windowStart = $clock();
    }

    public static function weightForPath(string $path): int
    {
        return $path === 'create' ? self::CREATE_WEIGHT : self::DEFAULT_WEIGHT;
    }

    public function reserve(string $path): void
    {
        $this->rollWindow();
        $now = ($this->clock)();
        $cost = self::weightForPath($path);
        $limit = $path === 'create' ? self::CREATE_GATE : self::SOFT_CAP;
        if ($this->backoffUntil !== null && $this->backoffUntil > $now) {
            $this->deny($path, 'backoff', $cost, $limit, "Swap provider API is in backoff until {$this->backoffUntil}.");
        }
        if ($this->used + $cost > $limit) {
            $this->deny($path, 'exhausted', $cost, $limit, "Swap provider API weight budget exhausted ({$this->used}+{$cost} > {$limit}).");
        }
        $this->used += $cost;
    }

    public function markRateLimited(): void
    {
        $now = ($this->clock)();
        $this->used = max($this->used, self::SOFT_CAP);
        $this->backoffUntil = $now + self::BACKOFF_SECONDS;
    }

    private function rollWindow(): void
    {
        $now = ($this->clock)();
        if ($now - $this->windowStart < self::WINDOW_SECONDS) {
            return;
        }
        $this->windowStart = $now;
        $this->used = 0;
    }

    private function deny(string $path, string $reason, int $cost, int $limit, string $message): never
    {
        $denial = [
            'provider' => $this->providerId, 'path' => $path, 'reason' => $reason, 'message' => $message,
            'used' => $this->used, 'cost' => $cost, 'gate' => $limit, 'window_start' => $this->windowStart,
        ];
        if ($this->backoffUntil !== null) {
            $denial['backoff_until'] = $this->backoffUntil;
        }
        throw new WeightBudgetError($message, $denial);
    }
}
