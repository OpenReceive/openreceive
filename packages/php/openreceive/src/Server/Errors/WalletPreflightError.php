<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

use OpenReceive\Kernel;

/** Boot-time refusal: the connection offered an info method but preflight could not clear it. */
final class WalletPreflightError extends \RuntimeException
{
    public function __construct(string $reason)
    {
        parent::__construct(
            "OpenReceive wallet preflight failed: {$reason} Use a receive-only NWC connection advertising "
            . 'make_invoice and list_transactions. Get one here: ' . Kernel::NWC_CODE_HELP_URL
        );
    }
}
