<?php

declare(strict_types=1);

namespace OpenReceive\Rates;

/**
 * BTC fiat rates from a disposable process-local cache, refreshing from the
 * primary feed first and the fallback second. Port of the JS CachedPriceFeed
 * state machine: fresh entries serve for cacheSeconds; a refresh failure
 * fails closed for cacheSeconds unless a still-quotable observation (younger
 * than the invoice quote TTL) is in hand. PHP requests are single-threaded,
 * so the concurrent in-flight join of the Node/Ruby twins reduces to the
 * "refresh already started" refusal.
 */
final class CachedPriceFeed implements PriceProvider
{
    private readonly int $cacheSeconds;
    /** @var callable(): int */
    private $clock;
    /** @var array{entry?: array{rates: array{bitcoin: array<string, string>}, source: string, fetched_at: int}, refresh_started_at?: int, refresh_failed_at?: int, refresh_error?: string}|null */
    private ?array $state = null;

    /** @param list<string> $currencies @param (callable(): int)|null $clock */
    public function __construct(
        array $currencies,
        private readonly HttpSimplePriceProvider $primary,
        private readonly HttpSimplePriceProvider $fallback,
        ?int $cacheSeconds = null,
        ?callable $clock = null,
    ) {
        if ($currencies === []) {
            throw new \InvalidArgumentException('CachedPriceFeed requires at least one currency');
        }
        $cacheSeconds ??= Rates::PRICE_FEED_CACHE_SECONDS;
        if ($cacheSeconds <= 0) {
            throw new \InvalidArgumentException('CachedPriceFeed cacheSeconds must be a positive integer');
        }
        if ($cacheSeconds > Rates::INVOICE_QUOTE_TTL_SECONDS) {
            throw new \InvalidArgumentException('CachedPriceFeed cacheSeconds must not exceed the ' . Rates::INVOICE_QUOTE_TTL_SECONDS . 's invoice quote TTL');
        }
        $this->cacheSeconds = $cacheSeconds;
        $this->clock = $clock ?? static fn (): int => time();
    }

    public function source(): string
    {
        return $this->state['entry']['source'] ?? 'primary';
    }

    /** @param list<string> $currencies @return array{bitcoin: array<string, string>} */
    public function btcFiatRates(array $currencies): array
    {
        return $this->btcFiatRatesWithSource($currencies)['rates'];
    }

    /** @param list<string> $currencies @return array{source: string, rates: array{bitcoin: array<string, string>}} */
    public function btcFiatRatesWithSource(array $currencies): array
    {
        $now = ($this->clock)();
        $entry = $this->readOrRefresh($now);
        return ['source' => $entry['source'], 'rates' => Rates::parseSimplePriceResponse($entry['rates'], $currencies)];
    }

    public function btcFiatPrice(string $currency): string
    {
        return $this->btcFiatRates([$currency])['bitcoin'][Rates::normalizeFiatCurrency($currency)];
    }

    /**
     * Forces a live refresh for explicit operational probes; raises if both feeds fail.
     *
     * @param list<string>|null $currencies
     * @return array{source: string, rates: array{bitcoin: array<string, string>}}
     */
    public function healthCheck(?array $currencies = null): array
    {
        $entry = $this->refresh(($this->clock)(), $this->state['entry'] ?? null);
        return [
            'source' => $entry['source'],
            'rates' => $currencies === null || $currencies === [] ? $entry['rates'] : Rates::parseSimplePriceResponse($entry['rates'], $currencies),
        ];
    }

    /** @return array{rates: array{bitcoin: array<string, string>}, source: string, fetched_at: int} */
    private function readOrRefresh(int $now): array
    {
        $state = $this->state;
        $entry = $state['entry'] ?? null;
        $entryAge = $entry === null ? null : $this->stampAge($entry['fetched_at'], $now);
        if ($entry !== null && $entryAge !== null && $entryAge < $this->cacheSeconds) {
            return $entry;
        }
        // Stale-while-revalidate is bounded by the invoice quote TTL: a rate
        // observed longer ago than a quote may live must never price a new invoice.
        $quotable = $entryAge !== null && $entryAge < Rates::INVOICE_QUOTE_TTL_SECONDS ? $entry : null;
        if ($state !== null && isset($state['refresh_failed_at']) && $this->isRecent($state['refresh_failed_at'], $now)) {
            if ($quotable !== null) {
                return $quotable;
            }
            $message = "price feed refresh already failed within {$this->cacheSeconds}s";
            if (($state['refresh_error'] ?? '') !== '') {
                $message .= ": {$state['refresh_error']}";
            }
            throw new PriceFeedError($message);
        }
        if ($state !== null && isset($state['refresh_started_at']) && !isset($state['refresh_failed_at'])
            && $this->isRecent($state['refresh_started_at'], $now) && !isset($state['entry'])) {
            // A re-entrant read while this process's own refresh is running (a
            // provider calling back into the feed) fails closed rather than recursing.
            throw new PriceFeedError("price feed refresh already started within {$this->cacheSeconds}s");
        }
        $claimed = ['refresh_started_at' => $now];
        if ($entry !== null) {
            $claimed['entry'] = $entry;
        }
        $this->state = $claimed;
        return $this->refresh($now, $entry);
    }

    private function isRecent(int $timestamp, int $now): bool
    {
        $age = $this->stampAge($timestamp, $now);
        return $age !== null && $age < $this->cacheSeconds;
    }

    private function stampAge(int $timestamp, int $now): ?int
    {
        $age = $now - $timestamp;
        if ($age < -Rates::PRICE_FEED_CLOCK_SKEW_SECONDS) {
            return null;
        }
        return max($age, 0);
    }

    /**
     * @param array{rates: array{bitcoin: array<string, string>}, source: string, fetched_at: int}|null $previous
     * @return array{rates: array{bitcoin: array<string, string>}, source: string, fetched_at: int}
     */
    private function refresh(int $now, ?array $previous): array
    {
        $failures = [];
        foreach ([$this->primary, $this->fallback] as $provider) {
            try {
                $entry = ['rates' => $provider->allBtcFiatRates(), 'source' => $provider->source, 'fetched_at' => $now];
                $this->state = ['entry' => $entry];
                return $entry;
            } catch (\Throwable $e) {
                $failures[] = "{$provider->source}: {$e->getMessage()}";
            }
        }
        $message = 'all price feeds failed: ' . implode('; ', $failures);
        $failed = ['refresh_started_at' => $now, 'refresh_failed_at' => $now, 'refresh_error' => $message];
        if ($previous !== null) {
            $failed['entry'] = $previous;
        }
        $this->state = $failed;
        throw new PriceFeedError($message);
    }
}
