<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 415 — body-bearing routes accept application/json only (the CSRF-equivalent on cookie mounts). */
final class UnsupportedMediaTypeError extends HttpError
{
    public function __construct(string $message = 'Request content type must be application/json.')
    {
        parent::__construct(415, 'INVALID_REQUEST', $message);
    }
}
