<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * A reservation would exceed the process-local weight budget. Quote
 * classification maps it to provider_rate_limited; the denial diagnostics
 * (provider, path, reason, used/cost/gate, window start, backoff) ride the error.
 */
final class WeightBudgetError extends \RuntimeException
{
    /** @param array<string, mixed> $denial */
    public function __construct(string $message, public readonly array $denial = [])
    {
        parent::__construct($message);
    }
}
