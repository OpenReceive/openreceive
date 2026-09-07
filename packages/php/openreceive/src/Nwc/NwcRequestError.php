<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

/** A NIP-47 error reply (`{ code, message }`), carrying the wallet's code for Errors::normalizeWalletError. */
final class NwcRequestError extends \RuntimeException implements CodedError
{
    public function __construct(private readonly string $walletCode, string $message)
    {
        parent::__construct($message);
    }

    public function errorCode(): string
    {
        return $this->walletCode;
    }
}
