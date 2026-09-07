<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/**
 * A wallet/relay failure normalized per the error-normalization vectors:
 * canonical code + retryable, 503 when retryable and 502 otherwise, so a
 * browser distinguishes "retry" from "bug" the same way against every engine.
 */
final class WalletFailureError extends HttpError
{
    /** @param array{code: string, message: string, retryable?: bool, details?: array<string, mixed>} $normalized */
    public function __construct(array $normalized)
    {
        $retryable = $normalized['retryable'] ?? false;
        parent::__construct($retryable ? 503 : 502, $normalized['code'], $normalized['message'], $retryable, $normalized['details'] ?? null);
    }
}
