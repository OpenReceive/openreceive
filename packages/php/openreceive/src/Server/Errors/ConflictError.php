<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 409 — already paid, a live attempt on the same rail, or a non-refundable provider state. */
final class ConflictError extends HttpError
{
    public function __construct(string $message = 'Conflict.')
    {
        parent::__construct(409, 'CONFLICT', $message);
    }
}
