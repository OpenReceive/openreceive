<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 503 — infrastructure failed to persist the attempt; retryable INTERNAL, never a payer-blaming conflict. */
final class HostPersistenceError extends HttpError
{
    public function __construct(string $message = 'The host could not persist this payment attempt; payer instructions were withheld. Please retry.')
    {
        parent::__construct(503, 'INTERNAL', $message, retryable: true);
    }
}
