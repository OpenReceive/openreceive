<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

use OpenReceive\Kernel;

/** Boot-time refusal: the configured NWC connection advertises spend methods. */
final class SpendCapableWalletError extends \RuntimeException
{
    /** @param list<string> $methods */
    public function __construct(array $methods)
    {
        parent::__construct(
            "This NWC connection is NOT receive-only.\n"
            . 'The wallet info event advertises spend method(s): ' . implode(', ', $methods) . ".\n"
            . "A leaked spend-capable NWC code lets an attacker drain the wallet, so OpenReceive refuses to boot with it.\n"
            . 'Get a receive-only NWC code here: ' . Kernel::NWC_CODE_HELP_URL . "\n"
            . 'If this wallet cannot mint a receive-only code and you accept the risk, set '
            . 'allowSpendCapableWallet: true (or OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true).'
        );
    }
}
