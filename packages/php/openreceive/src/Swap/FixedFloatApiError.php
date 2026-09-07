<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

use OpenReceive\Http\TransportException;

/**
 * A FixedFloat(-compatible) API failure. Deliberately NOT an HttpError: a
 * provider failure must reach the payer as the redacted 500 "Internal server
 * error." exactly like the JS and Ruby engines.
 */
final class FixedFloatApiError extends \RuntimeException
{
    public const KINDS = ['api', 'http', 'invalid_json', 'network', 'rate_limited', 'timeout'];

    public function __construct(
        public readonly string $path,
        public readonly string $kind,
        string $message,
        public readonly ?int $httpStatus = null,
        public readonly mixed $fixedfloatCode = null,
        public readonly ?string $fixedfloatMessage = null,
    ) {
        parent::__construct($message);
    }

    public static function fromTransportError(string $path, \Throwable $error): self
    {
        $aborted = $error instanceof TransportException ? $error->timedOut : str_contains(strtolower($error->getMessage()), 'timed out');
        return new self(
            $path,
            $aborted ? 'timeout' : 'network',
            $aborted ? "FixedFloat {$path} request timed out." : "FixedFloat {$path} request failed before a response was received."
        );
    }
}
