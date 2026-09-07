<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 429 RATE_LIMITED, retryable, with a Retry-After hint of 60 seconds (mirrors JS). */
final class RateLimitedError extends HttpError
{
    public function __construct(string $message = 'Too many requests.')
    {
        parent::__construct(429, 'RATE_LIMITED', $message, retryable: true, retryAfterSeconds: 60);
    }
}
