<?php

declare(strict_types=1);

namespace OpenReceive\Rates;

/** Serves the fixed static_mock table (BTC/USD 50000.00): tests, docs, the testkit demo mode. */
final class StaticPriceProvider implements PriceProvider
{
    public function source(): string
    {
        return Rates::STATIC_PRICE_SOURCE_ID;
    }

    /** @param list<string> $currencies @return array{bitcoin: array<string, string>} */
    public function btcFiatRates(array $currencies): array
    {
        $rates = [];
        foreach ($currencies as $currency) {
            $rates[Rates::normalizeFiatCurrency($currency)] = Rates::staticBtcFiatPrice($currency);
        }
        return ['bitcoin' => $rates];
    }

    public function btcFiatPrice(string $currency): string
    {
        return Rates::staticBtcFiatPrice($currency);
    }
}
