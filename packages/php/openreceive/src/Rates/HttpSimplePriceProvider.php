<?php

declare(strict_types=1);

namespace OpenReceive\Rates;

use OpenReceive\Http\HttpTransport;
use OpenReceive\Http\StreamTransport;
use OpenReceive\Http\TransportException;

/** Fetches a Simple Price compatible endpoint; a slow endpoint fails within `timeoutMs` so the caller can fall through to another feed. */
final class HttpSimplePriceProvider
{
    private readonly HttpTransport $http;

    public function __construct(
        public readonly string $url,
        public readonly string $source,
        ?HttpTransport $http = null,
        public readonly ?int $timeoutMs = null,
    ) {
        $this->http = $http ?? new StreamTransport();
    }

    /** @param list<string> $currencies @return array{bitcoin: array<string, string>} */
    public function btcFiatRates(array $currencies): array
    {
        return Rates::parseSimplePriceResponse($this->fetchJson(), $currencies);
    }

    /**
     * Every well-formed currency the endpoint carries, for caching the whole feed in one read.
     *
     * @return array{bitcoin: array<string, string>}
     */
    public function allBtcFiatRates(): array
    {
        return Rates::parseAvailableSimplePriceResponse($this->fetchJson());
    }

    private function fetchJson(): mixed
    {
        try {
            $response = $this->http->request('GET', $this->url, ['accept' => 'application/json'], null, $this->timeoutMs);
        } catch (TransportException $e) {
            if ($e->timedOut && $this->timeoutMs !== null) {
                throw new PriceFeedError("price source {$this->source} did not respond within {$this->timeoutMs}ms", 0, $e);
            }
            throw new PriceFeedError("price source {$this->source} request failed: {$e->getMessage()}", 0, $e);
        }
        if ($response['status'] < 200 || $response['status'] > 299) {
            throw new PriceFeedError("price source {$this->source} returned HTTP {$response['status']}");
        }
        try {
            return json_decode($response['body'], true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
        } catch (\JsonException $e) {
            throw new PriceFeedError("price source {$this->source} returned invalid JSON", 0, $e);
        }
    }
}
