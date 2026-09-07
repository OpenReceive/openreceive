<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

/** A throwable carrying a canonical or wallet error code string, read by Errors::normalizeWalletError. */
interface CodedError extends \Throwable
{
    public function errorCode(): string;
}
