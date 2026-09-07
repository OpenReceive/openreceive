<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 400 — the request body/params were malformed or violated a contract rule. */
final class ValidationError extends HttpError
{
    public function __construct(string $message = 'Invalid request.')
    {
        parent::__construct(400, 'INVALID_REQUEST', $message);
    }
}
