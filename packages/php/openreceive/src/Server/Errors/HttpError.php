<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

use OpenReceive\Nwc\CodedError;

/**
 * Base of every server-layer error: an HTTP status plus a canonical code from
 * spec/schemas/error.schema.json, so the request handler can map it to an
 * error body directly. Anything else that escapes is redacted to an opaque 500.
 */
class HttpError extends \RuntimeException implements CodedError
{
    /** @param array<string, mixed>|null $details */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly ?bool $retryable = null,
        public readonly ?array $details = null,
        public readonly ?int $retryAfterSeconds = null,
    ) {
        parent::__construct($message);
    }

    public function errorCode(): string
    {
        return $this->errorCode;
    }
}
