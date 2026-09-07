<?php

declare(strict_types=1);

namespace OpenReceive\Server\Errors;

/** 502 — the wallet responded but violated the receive-checkout contract. */
final class WalletContractError extends HttpError
{
    public function __construct(string $message = 'Wallet violated the receive-checkout contract.')
    {
        parent::__construct(502, 'UNSUPPORTED_METHOD', $message);
    }
}
