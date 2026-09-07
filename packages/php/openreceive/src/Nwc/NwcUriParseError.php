<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

/** A malformed NWC connection string. `code` is shared with the JS parser (nwc-uri-parse vectors). */
final class NwcUriParseError extends \InvalidArgumentException
{
    public readonly ?string $redacted;

    public function __construct(public readonly string $errorCode, string $message, ?string $uri = null)
    {
        parent::__construct($message);
        $this->redacted = $uri === null ? null : Uri::redact($uri);
    }
}
