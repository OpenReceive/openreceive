<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

use OpenReceive\Kernel;

/**
 * Boot-time refusal: the connection offered an info method but preflight could not clear it.
 * When reading the wallet info failed, `getPrevious()` is that failure, so a host can tell a
 * relay that did not answer (a WalletUnavailableError) from a code that is wrong.
 */
final class WalletPreflightError extends \RuntimeException
{
    public function __construct(string $reason, ?\Throwable $previous = null)
    {
        parent::__construct(
            "OpenReceive wallet preflight failed: {$reason} Use a receive-only NWC connection advertising "
            . 'make_invoice and list_transactions. Get one here: ' . Kernel::NWC_CODE_HELP_URL,
            0,
            $previous
        );
    }
}
