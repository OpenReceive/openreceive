<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * The process-local request guard refused a call: it would exceed the
 * provider's limits (`exhausted`), or a 429 stand-off is running (`backoff`).
 * Quote classification maps it to provider_rate_limited; the denial
 * diagnostics (provider, path, reason, used/cost/gate, window start, when a
 * stand-off ends, and creates/create_limit for a provider that counts
 * creates) ride the error.
 */
final class WeightBudgetError extends \RuntimeException
{
    /** @param array<string, mixed> $denial */
    public function __construct(string $message, public readonly array $denial = [])
    {
        parent::__construct($message);
    }
}
