<?php

declare(strict_types=1);

namespace OpenReceive\Rates;

/** The service's price contract: one decimal price string for one uppercase ISO 4217 currency, and where it came from. */
interface PriceProvider
{
    public function source(): string;

    /** @throws \InvalidArgumentException for an unsupported currency; PriceFeedError when a live feed cannot serve */
    public function btcFiatPrice(string $currency): string;
}
