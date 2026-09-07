<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 413 — contract bodies are tiny; anything larger is rejected before any host callback runs. */
final class PayloadTooLargeError extends HttpError
{
    public function __construct(string $message = 'Request body is too large.')
    {
        parent::__construct(413, 'INVALID_REQUEST', $message);
    }
}
