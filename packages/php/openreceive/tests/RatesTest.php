<?php

declare(strict_types=1);

namespace OpenReceive\Tests;

use OpenReceive\Http\CallableTransport;
use OpenReceive\Rates\CachedPriceFeed;
use OpenReceive\Rates\HttpSimplePriceProvider;
use OpenReceive\Rates\PriceFeedError;
use OpenReceive\Rates\Rates;
use PHPUnit\Framework\TestCase;

final class RatesTest extends TestCase
{
    use VectorSupport;

    public function testConstantsMatchTheSharedPriceSourcesData(): void
    {
        $sources = self::readJson(dirname(__DIR__, 4) . '/spec/data/rates/price-sources.json');
        self::assertSame($sources['cache_seconds'], Rates::PRICE_FEED_CACHE_SECONDS);
        self::assertSame($sources['invoice_quote_ttl_seconds'], Rates::INVOICE_QUOTE_TTL_SECONDS);
        self::assertSame($sources['primary_timeout_ms'], Rates::PRICE_FEED_PRIMARY_TIMEOUT_MS);
        $byId = array_column($sources['sources'], null, 'id');
        self::assertSame($byId['static_mock']['rates'], Rates::STATIC_BTC_FIAT_RATES);
        self::assertSame($byId['primary']['url'], Rates::PRIMARY_PRICE_FEED_URL);
        self::assertSame($byId['fallback']['url'], Rates::FALLBACK_PRICE_FEED_URL);
        self::assertSame($byId['primary']['env_override'], Rates::PRICE_FEED_PRIMARY_URL_ENV);
        self::assertSame($byId['fallback']['env_override'], Rates::PRICE_FEED_FALLBACK_URL_ENV);
    }

    public function testDefaultFallbackWorksWhenPrimaryRejectsTheRequest(): void
    {
        $requests = [];
        $http = new CallableTransport(static function (string $method, string $url) use (&$requests): array {
            $requests[] = $url;
            if ($url === Rates::PRIMARY_PRICE_FEED_URL) {
                return ['status' => 403, 'body' => 'Forbidden'];
            }
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            // The fallback rejects the whole query if it contains retired VEF.
            if (in_array('vef', explode(',', $query['vs_currencies'] ?? ''), true)) {
                return ['status' => 400, 'body' => '{"error":"Unknown currencies: vef"}'];
            }
            return ['status' => 200, 'body' => '{"bitcoin":{"usd":"50000.00"}}'];
        });
        $feed = Rates::createCachedLivePriceFeed(['USD'], $http);
        self::assertSame('50000.00', $feed->btcFiatPrice('USD'));
        self::assertSame([Rates::PRIMARY_PRICE_FEED_URL, Rates::FALLBACK_PRICE_FEED_URL], $requests);
    }

    public function testJsonNumbersBecomePlainDecimalStringsWithoutFloatArithmetic(): void
    {
        self::assertSame('50000', Rates::normalizeBtcFiatRate(50000, 'bitcoin.usd'));
        self::assertSame('64123.5', Rates::normalizeBtcFiatRate(json_decode('64123.5'), 'bitcoin.usd'));
        self::assertSame('0.0000123', Rates::normalizeBtcFiatRate(json_decode('1.23e-5'), 'bitcoin.usd'));
        self::assertSame('64123.50', Rates::normalizeBtcFiatRate('64123.50', 'bitcoin.usd'));
        $this->expectException(\InvalidArgumentException::class);
        Rates::normalizeBtcFiatRate(-1, 'bitcoin.usd');
    }

    public function testStrictAndTolerantParsesDisagreeOnAMissingCurrency(): void
    {
        $response = ['bitcoin' => ['usd' => 50000, 'eur' => 'bogus', 'x1' => 1]];
        self::assertSame(['bitcoin' => ['usd' => '50000']], Rates::parseAvailableSimplePriceResponse($response));
        $this->expectException(\InvalidArgumentException::class);
        Rates::parseSimplePriceResponse($response, ['USD', 'EUR']);
    }

    /** @param list<array{status: int, body: string}|\Throwable> $primaryReplies @param list<array{status: int, body: string}|\Throwable> $fallbackReplies */
    private function feed(array $primaryReplies, array $fallbackReplies, int &$now): CachedPriceFeed
    {
        $transport = new CallableTransport(static function (string $method, string $url) use (&$primaryReplies, &$fallbackReplies): array {
            $queue = str_contains($url, 'primary') ? $primaryReplies : $fallbackReplies;
            $reply = array_shift($queue);
            if (str_contains($url, 'primary')) {
                $primaryReplies = $queue;
            } else {
                $fallbackReplies = $queue;
            }
            if ($reply instanceof \Throwable) {
                throw $reply;
            }
            return $reply ?? ['status' => 500, 'body' => ''];
        });
        return new CachedPriceFeed(
            ['USD'],
            new HttpSimplePriceProvider('https://primary.test/price', 'primary', $transport, 5000),
            new HttpSimplePriceProvider('https://fallback.test/price', 'fallback', $transport),
            60,
            static function () use (&$now): int {
                return $now;
            },
        );
    }

    public function testTheCachedFeedServesFreshFailsOverAndFailsClosed(): void
    {
        $now = 1_000;
        $ok = static fn (string $price): array => ['status' => 200, 'body' => json_encode(['bitcoin' => ['usd' => $price]])];
        $feed = $this->feed([$ok('50000.00'), ['status' => 503, 'body' => 'down'], ['status' => 503, 'body' => 'down']], [$ok('50001.00'), ['status' => 500, 'body' => '']], $now);
        self::assertSame('50000.00', $feed->btcFiatPrice('USD'));
        $now = 1_030;
        self::assertSame('50000.00', $feed->btcFiatPrice('USD'), 'served from cache inside cache_seconds');
        $now = 1_061;
        $refreshed = $feed->btcFiatRatesWithSource(['USD']);
        self::assertSame('fallback', $refreshed['source'], 'primary failed, fallback served');
        self::assertSame('50001.00', $refreshed['rates']['bitcoin']['usd']);
        $now = 1_130;
        // Both feeds fail: the failing refresh itself fails closed…
        try {
            $feed->btcFiatPrice('USD');
            self::fail('the failed refresh was not reported');
        } catch (PriceFeedError $e) {
            self::assertStringContainsString('all price feeds failed', $e->getMessage());
        }
        // …and inside the backoff the still-quotable observation (younger than the invoice quote TTL) is served.
        $now = 1_135;
        self::assertSame('50001.00', $feed->btcFiatPrice('USD'));
        $now = 1_061 + Rates::INVOICE_QUOTE_TTL_SECONDS + 1;
        try {
            $feed->btcFiatPrice('USD');
            self::fail('a rate older than the quote TTL was served');
        } catch (PriceFeedError $e) {
            self::assertStringContainsString('all price feeds failed', $e->getMessage());
        }
    }

    public function testTheCacheWindowMustNotExceedTheQuoteTtl(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $transport = new CallableTransport(static fn (): array => ['status' => 200, 'body' => '{}']);
        new CachedPriceFeed(['USD'], new HttpSimplePriceProvider('u', 'primary', $transport), new HttpSimplePriceProvider('u', 'fallback', $transport), 601);
    }

    public function testEnvOverridesAreReadFromTheWellKnownNames(): void
    {
        self::assertSame(['primary_url' => 'https://p.test', 'fallback_url' => null], Rates::readPriceFeedUrlOverrides([Rates::PRICE_FEED_PRIMARY_URL_ENV => ' https://p.test ', Rates::PRICE_FEED_FALLBACK_URL_ENV => '']));
    }
}
