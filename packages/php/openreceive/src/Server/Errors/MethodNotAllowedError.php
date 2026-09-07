<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 405 — a known OpenReceive path called with the wrong HTTP method (INVALID_REQUEST, no Allow header, like JS). */
final class MethodNotAllowedError extends HttpError
{
    public function __construct(string $message = 'This OpenReceive route does not support that HTTP method.')
    {
        parent::__construct(405, 'INVALID_REQUEST', $message);
    }
}
