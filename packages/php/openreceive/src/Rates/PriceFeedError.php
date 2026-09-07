<?php

declare(strict_types=1);

namespace OpenReceive\Rates;

/** A live price feed could not serve a usable rate (network, HTTP status, fail-closed refresh window). */
final class PriceFeedError extends \RuntimeException
{
}
