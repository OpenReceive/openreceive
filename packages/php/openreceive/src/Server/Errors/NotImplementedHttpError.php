<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 501 — the host has not configured the capability this route needs (GET /rates without a price provider). */
final class NotImplementedHttpError extends HttpError
{
    public function __construct(string $message = 'Not implemented.')
    {
        parent::__construct(501, 'NOT_IMPLEMENTED', $message);
    }
}
