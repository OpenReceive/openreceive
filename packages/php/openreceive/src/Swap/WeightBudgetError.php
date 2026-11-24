<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * The process-local request guard refused a call: it would exceed the count
 * kept for FixedFloat (`exhausted`), or a 429 stand-off is running
 * (`backoff`). Quote classification maps it to provider_rate_limited; the
 * denial diagnostics (provider, path, reason, when a stand-off ends, and
 * used/cost/gate and the window start for a guard that counts) ride the error.
 */
final class WeightBudgetError extends \RuntimeException
{
    /** @param array<string, mixed> $denial */
    public function __construct(string $message, public readonly array $denial = [])
    {
        parent::__construct($message);
    }
}
