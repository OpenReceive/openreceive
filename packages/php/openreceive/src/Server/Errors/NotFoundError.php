<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 404 — the reference or payment attempt was not found. */
final class NotFoundError extends HttpError
{
    public function __construct(string $message = 'Not found.')
    {
        parent::__construct(404, 'NOT_FOUND', $message);
    }
}
