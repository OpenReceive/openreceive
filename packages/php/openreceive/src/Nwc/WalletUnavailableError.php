<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

use OpenReceive\Server\Errors\HttpError;

/** 503 WALLET_UNAVAILABLE — the wallet or relay could not be reached. */
final class WalletUnavailableError extends HttpError
{
    public function __construct(string $message = 'NWC wallet service is unavailable.')
    {
        parent::__construct(503, 'WALLET_UNAVAILABLE', $message, retryable: true);
    }
}
