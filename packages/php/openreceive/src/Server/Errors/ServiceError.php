<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** Generic service error with an explicit status + canonical code (the JS ServiceError). */
final class ServiceError extends HttpError
{
    /** @param array<string, mixed>|null $details */
    public function __construct(int $status, string $code, string $message, ?bool $retryable = null, ?array $details = null)
    {
        parent::__construct($status, $code, $message, $retryable, $details);
    }
}
