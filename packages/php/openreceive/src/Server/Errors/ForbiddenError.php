<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 403 — the host application did not authorize this request (FORBIDDEN, never the wallet's UNAUTHORIZED). */
final class ForbiddenError extends HttpError
{
    public function __construct(string $message = 'Forbidden.')
    {
        parent::__construct(403, 'FORBIDDEN', $message);
    }
}
