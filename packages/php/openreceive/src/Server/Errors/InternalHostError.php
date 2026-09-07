<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 500 INTERNAL raised deliberately with a payer-safe message (a host resolved an order without an amount). */
final class InternalHostError extends HttpError
{
    public function __construct(string $message = 'Internal server error.')
    {
        parent::__construct(500, 'INTERNAL', $message);
    }
}
