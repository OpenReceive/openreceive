<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Swap;

use OpenReceive\Http\CallableTransport;
use OpenReceive\Http\TransportException;
use OpenReceive\Swap\FixedFloatApiError;
use OpenReceive\Swap\FixedFloatProvider;
use OpenReceive\Swap\FixedFloatRates;
use OpenReceive\Swap\Swap;
use OpenReceive\Swap\SwapProviderLimits;
use OpenReceive\Swap\TransientCache;
use OpenReceive\Swap\WeightBudget;
use OpenReceive\Swap\WeightBudgetError;
use OpenReceive\Tests\Support\MemorySharedCache;
use PHPUnit\Framework\TestCase;

final class FixedFloatProviderTest extends TestCase
{
    private const RATES_XML = '<rates><item><from>USDTTRC</from><to>BTCLN</to><in>1 USDTTRC</in><out>0.00001 BTCLN</out><amount>1000</amount><minamount>10 USDTTRC</minamount><maxamount>5000 USDTTRC</maxamount><tofee>0.000001 BTC</tofee></item>'
        . '<item><from>USDTTRC</from><to>BTC</to><in>1</in><out>0.00001</out><amount>1</amount><minamount>1</minamount><maxamount>2</maxamount></item></rates>';

    /** @var list<array{method: string, url: string, headers: array<string, string>, body: ?string}> */
    private array $calls = [];

    /** @param array<string, array{status: int, body: string, headers?: array<string, string>}|\Throwable> $replies keyed by path suffix */
    private function provider(array $replies, ?TransientCache $cache = null, ?WeightBudget $budget = null): FixedFloatProvider
    {
        $transport = new CallableTransport(function (string $method, string $url, array $headers, ?string $body) use ($replies): array {
            $this->calls[] = ['method' => $method, 'url' => $url, 'headers' => $headers, 'body' => $body];
            foreach ($replies as $suffix => $reply) {
                if (str_ends_with($url, $suffix)) {
                    if ($reply instanceof \Throwable) {
                        throw $reply;
                    }
                    return $reply;
                }
            }
            return ['status' => 404, 'body' => ''];
        });
        $provider = new FixedFloatProvider('key-1', 'secret-1', 'ff-test', 'https://ff.test', null, $transport, static fn (): int => 5_000);
        if ($cache !== null) {
            $provider->attachSwapCache($cache);
        }
        if ($budget !== null) {
            $provider->attachWeightBudget($budget);
        }
        return $provider;
    }

    /** @return array{status: int, body: string} */
    private static function api(mixed $data, int $code = 0, string $msg = 'OK'): array
    {
        return ['status' => 200, 'body' => json_encode(['code' => $code, 'msg' => $msg, 'data' => $data], JSON_THROW_ON_ERROR)];
    }

    /** @return array<string, array{status: int, body: string}> */
    private static function catalogReplies(): array
    {
        return [
            '/api/v2/ccies' => self::api(['ccies' => [
                ['code' => 'USDTTRC', 'coin' => 'USDT', 'network' => 'TRC20', 'recv' => true, 'send' => true],
                ['code' => 'BTCLN', 'coin' => 'BTC', 'network' => 'Lightning', 'recv' => true, 'send' => true],
                ['code' => 'ETH', 'coin' => 'ETH', 'network' => 'ETH', 'recv' => false, 'send' => true],
            ]]),
            '/rates/fixed.xml' => ['status' => 200, 'body' => self::RATES_XML],
        ];
    }

    public function testTheCatalogAndQuoteComeFromCciesAndTheXmlRatesExport(): void
    {
        $provider = $this->provider(self::catalogReplies());
        self::assertSame(['USDT_TRON'], $provider->supportedPayInAssets(), 'recv=false currencies are omitted');
        $catalog = $provider->payInAssetCatalog();
        self::assertSame('USDT_TRON', $catalog[0]['pay_asset']);
        self::assertSame('10', $catalog[0]['minimum_pay_amount']);
        // 10 USDT at 0.00001 BTC/USDT = 0.0001 BTC = 10,000 sats.
        self::assertSame(10_000_000, $catalog[0]['minimum_invoice_amount_msats']);
        self::assertSame(5_000_000_000, $catalog[0]['maximum_invoice_amount_msats']);
        // 200,000 sats + 100 sats fee = 200,100 sats = 0.002001 BTC → 200.1 USDT.
        $quote = $provider->quote('USDT_TRON', 200_000_000);
        self::assertTrue($quote['available']);
        self::assertSame('200.1', $quote['pay_amount']);
        self::assertSame('ff-test', $quote['provider']);
        $small = $provider->quote('USDT_TRON', 1_000);
        self::assertFalse($small['available']);
        self::assertSame('amount_too_small', $small['unavailable_reason']);
        self::assertSame('This invoice is below the provider minimum.', $small['unavailable_message']);
        self::assertSame('POST', $this->calls[0]['method']);
        self::assertSame('key-1', $this->calls[0]['headers']['X-API-KEY']);
        self::assertSame(hash_hmac('sha256', '{}', 'secret-1'), $this->calls[0]['headers']['X-API-SIGN']);
    }

    public function testCreateStatusAndRefundNormalizeOrdersThroughTheDecisionTable(): void
    {
        $order = ['id' => 'ORD1', 'token' => 'tok', 'status' => 'NEW', 'from' => ['address' => 'TXYZ', 'amount' => '200.1', 'usd' => '200.10'], 'to' => ['usd' => '199.00'], 'time' => ['expiration' => 5_600]];
        $provider = $this->provider([
            ...self::catalogReplies(),
            '/api/v2/create' => self::api($order),
            '/api/v2/order' => self::api([...$order, 'status' => 'EMERGENCY', 'emergency' => ['status' => ['LESS'], 'choice' => 'NONE', 'repeat' => 0], 'from' => [...$order['from'], 'tx' => ['id' => 'dep-1', 'amount' => '150']]]),
            '/api/v2/emergency' => self::api(true),
        ]);
        $created = $provider->createSwap('USDT_TRON', 'lnbc1', 200_000_000);
        self::assertSame('ORD1', $created['provider_order_id']);
        self::assertSame('tok', $created['provider_token']);
        self::assertSame('awaiting_deposit', $created['state']);
        self::assertSame(5_600, $created['expires_at']);
        self::assertSame(['currency' => 'USD', 'pay_in_fiat' => '200.10', 'payout_fiat' => '199.00'], $created['fee']);
        self::assertArrayNotHasKey('deposit_tx_id', $created);
        $body = json_decode((string) end($this->calls)['body'], true);
        self::assertSame(['type' => 'fixed', 'fromCcy' => 'USDTTRC', 'toCcy' => 'BTCLN', 'direction' => 'to', 'amount' => '0.002', 'toAddress' => 'lnbc1'], $body);
        $status = $provider->getStatus($created);
        self::assertSame('refund_required', $status['state']);
        self::assertSame('underpaid', $status['refund_reason']);
        self::assertSame('dep-1', $status['deposit_tx_id']);
        self::assertSame('150', $status['deposit_received_amount']);
        self::assertFalse($status['emergency_repeat']);
        $provider->requestRefund($status, 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf');
        $refund = json_decode((string) end($this->calls)['body'], true);
        self::assertSame(['id' => 'ORD1', 'token' => 'tok', 'choice' => 'REFUND', 'address' => 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'], $refund);
    }

    public function testDiagnosticSinksCannotSeeCredentialsOrAffectProviderRequests(): void
    {
        $raw = ['id' => 'diagnostic-order', 'token' => 'invalid-token', 'status' => 'NEW',
            'from' => ['address' => 'fixture-address', 'amount' => '1.05'], 'time' => ['expiration' => 5600]];
        $provider = $this->provider(['/api/v2/order' => self::api($raw)]);
        $events = [];
        $sink = static function (array $event) use (&$events): void {
            $events[] = $event;
            throw new \RuntimeException('synthetic failing diagnostic sink');
        };
        $provider->attachApiRequestLogger($sink);
        $provider->attachApiResponseLogger($sink);
        $stored = ['provider' => 'ff-test', 'provider_order_id' => 'diagnostic-order', 'provider_token' => 'invalid-token',
            'pay_in_asset' => 'USDT_TRON', 'deposit_address' => 'fixture-address', 'deposit_amount' => '1.05', 'expires_at' => 5600, 'state' => 'awaiting_deposit'];
        $status = $provider->getStatus($stored);
        self::assertSame('invalid-token', $status['provider_token']);
        self::assertSame('invalid-token', json_decode($this->calls[0]['body'], true)['token']);
        self::assertCount(2, $events);
        self::assertStringNotContainsString('invalid-token', json_encode($events));
        self::assertStringNotContainsString('X-API', json_encode($events));
        foreach ($events as $event) {
            self::assertArrayNotHasKey('body', $event);
            self::assertArrayNotHasKey('data', $event);
            self::assertArrayNotHasKey('headers', $event);
        }
    }

    public function testAThinPollBodyKeepsThePersistedStateVerbatim(): void
    {
        $provider = $this->provider(['/api/v2/order' => self::api(['id' => 'ORD1', 'token' => 'tok'])]);
        $stored = ['provider' => 'ff-test', 'provider_order_id' => 'ORD1', 'provider_token' => 'tok', 'pay_in_asset' => 'USDT_TRON', 'deposit_address' => 'T1', 'deposit_amount' => '1', 'expires_at' => 9, 'state' => 'refund_pending', 'refund_reason' => 'underpaid'];
        $status = $provider->getStatus($stored);
        self::assertSame('refund_pending', $status['state']);
        self::assertSame('underpaid', $status['refund_reason']);
    }

    public function testApiHttpAndTransportFailuresAreClassifiedAndNeverCarryAContractCode(): void
    {
        $provider = $this->provider([
            '/api/v2/ccies' => ['status' => 429, 'body' => json_encode(['code' => 1, 'msg' => 'slow down'])],
        ], null, new WeightBudget('ff-test', static fn (): int => 5_000));
        try {
            $provider->supportedPayInAssets();
            self::fail('no error');
        } catch (FixedFloatApiError $e) {
            self::assertSame('rate_limited', $e->kind);
            self::assertSame(429, $e->httpStatus);
            self::assertSame('provider_rate_limited', Swap::classifyQuoteError($e));
            self::assertNotInstanceOf(\OpenReceive\Server\Errors\HttpError::class, $e);
        }
        // The 429 armed the backoff: the next reservation is refused locally.
        try {
            $provider->supportedPayInAssets();
            self::fail('no budget error');
        } catch (WeightBudgetError $e) {
            self::assertSame('backoff', $e->denial['reason']);
            self::assertSame('provider_rate_limited', Swap::classifyQuoteError($e));
        }
        $timeout = $this->provider(['/api/v2/ccies' => new TransportException('timed out', true)]);
        try {
            $timeout->supportedPayInAssets();
        } catch (FixedFloatApiError $e) {
            self::assertSame('timeout', $e->kind);
            self::assertSame('provider_unreachable', Swap::classifyQuoteError($e));
        }
        $api = $this->provider(['/api/v2/ccies' => self::api(null, 301, 'Invalid amount: min 12')]);
        try {
            $api->supportedPayInAssets();
        } catch (FixedFloatApiError $e) {
            self::assertSame('api', $e->kind);
            self::assertSame(301, $e->fixedfloatCode);
            self::assertSame('amount_too_small', Swap::classifyQuoteError($e));
        }
    }

    public function testTheTransientCacheServesStaleCatalogsButNeverStaleRates(): void
    {
        $now = 5_000;
        $cache = new TransientCache(static function () use (&$now): int {
            return $now;
        });
        $replies = self::catalogReplies();
        $provider = $this->provider($replies, $cache);
        self::assertSame(['USDT_TRON'], $provider->supportedPayInAssets());
        self::assertSame(['USDT_TRON'], $provider->supportedPayInAssets());
        self::assertCount(1, $this->calls, 'the second read is served from the cache');
        $provider->payInAssetCatalog();
        self::assertCount(2, $this->calls, 'rates fetched once');
        $now += FixedFloatRates::REFRESH_SECONDS + 1;
        $provider->payInAssetCatalog();
        self::assertCount(3, $this->calls, 'rates refreshed after their TTL while /ccies stays cached for a day');
    }

    public function testASharedCacheCarriesCatalogsAndRatesAcrossRequests(): void
    {
        $now = 5_000;
        $clock = static function () use (&$now): int {
            return $now;
        };
        $shared = new MemorySharedCache();
        // PHP builds a new provider and cache for every request.
        $request = fn (array $replies): FixedFloatProvider => $this->provider($replies, new TransientCache($clock, null, $shared));
        $request(self::catalogReplies())->payInAssetCatalog();
        self::assertCount(2, $this->calls, '/ccies and fixed.xml');
        $request(self::catalogReplies())->payInAssetCatalog();
        self::assertCount(2, $this->calls, 'the next request reads both from the shared cache');
        self::assertSame(
            ['openreceive:swap_limits:ff-test', 'openreceive:swap_rates:ff-test:fixed'],
            array_keys($shared->entries),
        );

        $now += FixedFloatRates::REFRESH_SECONDS + 1;
        $failing = [...self::catalogReplies(), '/rates/fixed.xml' => ['status' => 503, 'body' => 'down key-1']];
        try {
            $request($failing)->payInAssetCatalog();
        } catch (\Throwable) {
        }
        self::assertCount(3, $this->calls, 'expired rates are fetched again; the catalog is still fresh');
        self::assertStringNotContainsString('"error"', $shared->entries['openreceive:swap_rates:ff-test:fixed']['value'], 'failure text is not shared');
        try {
            $request(self::catalogReplies())->payInAssetCatalog();
        } catch (\Throwable) {
        }
        self::assertCount(3, $this->calls, 'a request inside the failure backoff does not retry the provider');
    }

    public function testRatesMathIsExactIntegerFixedPoint(): void
    {
        $pair = ['from' => 'USDTTRC', 'to' => 'BTCLN', 'in' => '1', 'out' => '0.00001', 'amount' => '1', 'minamount' => '10', 'maxamount' => '5000', 'tofee' => '0.000001 BTC'];
        self::assertSame('200.1', FixedFloatRates::quotePayAmount($pair, 200_000_000));
        self::assertSame('0.6', FixedFloatRates::quotePayAmount(['in' => '1', 'out' => '0.00001'], 600_000), 'no tofee: 600 sats at 0.00001 BTC/USDT');
        self::assertSame(-1, FixedFloatRates::compareDecimalAmounts('9.99', '10'));
        self::assertSame(1, FixedFloatRates::compareDecimalAmounts('10.000001', '10'));
        self::assertNull(FixedFloatRates::compareDecimalAmounts('x', '10'));
        self::assertSame(100, FixedFloatRates::parseTofeeBtcSats('0.000001 BTC'));
        self::assertNull(FixedFloatRates::parseTofeeBtcSats('1 USDT'));
        self::assertSame('0.001', FixedFloatProvider::amountMsatsToBtcString(100_000_000));
        self::assertSame('1', FixedFloatProvider::amountMsatsToBtcString(100_000_000_000));
        $index = FixedFloatRates::deserializeIndex(FixedFloatRates::serializeIndex(['fetched_at' => 1, 'pairs' => ['USDTTRC:BTCLN' => $pair]]));
        self::assertSame($pair, $index['pairs']['USDTTRC:BTCLN']);
        $this->expectException(\InvalidArgumentException::class);
        new FixedFloatProvider('k', 's', 'Bad Id');
    }

    public function testTheWeightBudgetWindowRollsButTheBackoffDoesNot(): void
    {
        $now = 0;
        $budget = new WeightBudget('p', static function () use (&$now): int {
            return $now;
        });
        for ($i = 0; $i < 3; $i++) {
            $budget->reserve('create');
        }
        try {
            $budget->reserve('create');
            self::fail('the create gate did not hold');
        } catch (WeightBudgetError $e) {
            self::assertSame('exhausted', $e->denial['reason']);
            self::assertSame(150, $e->denial['gate']);
        }
        $budget->reserve('order');
        $now = 60;
        $budget->reserve('create');
        $budget->markRateLimited();
        $now = 119;
        try {
            $budget->reserve('order');
            self::fail('the backoff was forgiven by the rolling window');
        } catch (WeightBudgetError $e) {
            self::assertSame('backoff', $e->denial['reason']);
            self::assertSame(120, $e->denial['backoff_until']);
        }
    }

    // --- provider limits: the guard is sized by who the provider is ----------

    /** @return array{reason: string, message: string, backoff_until?: int, creates?: int, create_limit?: int}|null the denial, or null when the guard allows it */
    private static function denial(callable $call): ?array
    {
        try {
            $call();
            return null;
        } catch (WeightBudgetError $e) {
            return $e->denial;
        }
    }

    public function testTheProvidersHostPicksItsLimits(): void
    {
        self::assertSame('lightning-swap', (new FixedFloatProvider('k', 's', 'ls', 'https://lightning-swap.com'))->limits()->profile);
        self::assertSame('lightning-swap', (new FixedFloatProvider('k', 's', 'ls', 'https://api.LIGHTNING-SWAP.com/v1/'))->limits()->profile);
        self::assertSame('fixedfloat', (new FixedFloatProvider('k', 's'))->limits()->profile, 'the default base URL is FixedFloat');
        // An unknown host, and a look-alike, get the stricter FixedFloat limits.
        self::assertSame('fixedfloat', $this->provider([])->limits()->profile);
        self::assertSame('fixedfloat', (new FixedFloatProvider('k', 's', 'x', 'https://evil-lightning-swap.com'))->limits()->profile);
        // A guard built with no limits is the FixedFloat one.
        self::assertSame('fixedfloat', (new WeightBudget('p', static fn (): int => 0))->limits()->profile);
    }

    public function testALightningSwapGuardAllowsThirtyCreatesAMinuteAndKeepsStatusCallsGoing(): void
    {
        $now = 1_000;
        $budget = new WeightBudget('lightning-swap-com', static function () use (&$now): int {
            return $now;
        }, SwapProviderLimits::lightningSwap());
        for ($i = 0; $i < 30; $i++) {
            $budget->reserve('create');
        }
        $denied = self::denial(static fn () => $budget->reserve('create'));
        self::assertNotNull($denied);
        self::assertSame('exhausted', $denied['reason']);
        self::assertSame('Swap provider create budget exhausted (30+1 > 30).', $denied['message']);
        self::assertSame(30, $denied['creates']);
        self::assertSame(30, $denied['create_limit']);
        // The swaps that exist can still be read and refunded.
        $budget->reserve('order');
        $budget->reserve('emergency');
        $now += 60;
        $budget->reserve('create');
    }

    public function testAskingWhetherACreateIsAvailableUsesNoBudget(): void
    {
        $budget = new WeightBudget('fixedfloat', static fn (): int => 1_000);
        for ($i = 0; $i < 10; $i++) {
            $budget->assertAvailable('create');
        }
        for ($i = 0; $i < 3; $i++) {
            $budget->reserve('create');
        }
        $denied = self::denial(static fn () => $budget->assertAvailable('create'));
        self::assertSame('exhausted', $denied['reason'] ?? null);
        self::assertSame('Swap provider API weight budget exhausted (150+50 > 150).', $denied['message'] ?? null);
        self::assertArrayNotHasKey('create_limit', $denied ?? [], 'FixedFloat counts weight, not creates');
        // The provider asks the guard the service attached, and is not refused without one.
        $provider = $this->provider([], null, $budget);
        self::assertSame('exhausted', self::denial(static fn () => $provider->assertCreateAvailable())['reason'] ?? null);
        $this->provider([])->assertCreateAvailable();
        self::assertSame([], $this->calls, 'asking makes no provider call');
    }

    public function testAStandOffLastsForTheWaitTheProviderNamesWithinTheProfilesBounds(): void
    {
        $now = 1_000;
        $clock = static function () use (&$now): int {
            return $now;
        };
        $until = static fn (WeightBudget $budget, string $path): ?int => self::denial(static fn () => $budget->reserve($path))['backoff_until'] ?? null;
        // FixedFloat: every call stops, for at least a minute and at most an hour.
        $fixedFloat = new WeightBudget('fixedfloat', $clock);
        $fixedFloat->markRateLimited('create', 5);
        self::assertSame(1_060, $until($fixedFloat, 'order'));
        $now = 2_000;
        $fixedFloat->markRateLimited(retryAfterSeconds: 999_999);
        self::assertSame(5_600, $until($fixedFloat, 'order'), 'no path named: every call stands off');
        // Lightning Swap: a 429 on a create stops creates only.
        $now = 1_000;
        $lightning = new WeightBudget('lightning-swap-com', $clock, SwapProviderLimits::lightningSwap());
        $lightning->markRateLimited('create', 12.2);
        self::assertSame(1_013, $until($lightning, 'create'), 'a fractional wait is rounded up');
        $lightning->reserve('order');
        // A later, shorter 429 never shortens a stand-off already running.
        $lightning->markRateLimited('create', 1);
        self::assertSame(1_013, $until($lightning, 'create'));
        // A wait that is not a positive number is no wait named: the profile's minute.
        foreach ([0, -5, NAN, INF, null] as $notAWait) {
            $now += 10_000;
            $lightning->markRateLimited('create', $notAWait);
            self::assertSame($now + 60, $until($lightning, 'create'), var_export($notAWait, true));
        }
        // A 429 on any other call means the account's API budget is spent: all stop.
        $now += 10_000;
        $lightning->markRateLimited('order', 86_000);
        self::assertSame($now + 300, $until($lightning, 'order'), 'a day-long wait is retried after five minutes');
        self::assertSame($now + 300, $until($lightning, 'create'));
    }

    public function testA429HandsTheGuardThePathAndTheProvidersOwnWait(): void
    {
        $stored = ['provider' => 'ff-test', 'provider_order_id' => 'ORD1', 'provider_token' => 'tok', 'pay_in_asset' => 'USDT_TRON', 'deposit_address' => 'T1', 'deposit_amount' => '1', 'expires_at' => 9, 'state' => 'awaiting_deposit'];
        // The helper's clock stands at 5,000; the Lightning Swap limits honor a wait from one second up.
        $standOff = function (array $reply) use ($stored): ?int {
            $budget = new WeightBudget('ff-test', static fn (): int => 5_000, SwapProviderLimits::lightningSwap());
            $provider = $this->provider(['/api/v2/order' => $reply], null, $budget);
            try {
                $provider->getStatus($stored);
                self::fail('the 429 did not raise');
            } catch (FixedFloatApiError $e) {
                self::assertSame('rate_limited', $e->kind);
            }
            return self::denial(static fn () => $budget->assertAvailable('order'))['backoff_until'] ?? null;
        };
        // Lightning Swap answers a refusal with Retry-After and a body.
        self::assertSame(5_017, $standOff(['status' => 429, 'headers' => ['retry-after' => '17'], 'body' => '{"code":429,"msg":"Rate limit","data":null}']));
        self::assertSame(5_041, $standOff(['status' => 429, 'body' => '{"code":429,"msg":"Rate limit","data":{"errors":["RATE_LIMIT"],"retry_after":41}}']));
        self::assertSame(5_060, $standOff(['status' => 429, 'body' => '{"code":1,"msg":"Too many requests"}']), 'no wait named');
        // The header wins over the body; a header that is not whole seconds is not a wait.
        self::assertSame(5_009, $standOff(['status' => 429, 'headers' => ['Retry-After' => ' 9 '], 'body' => '{"code":429,"data":{"retry_after":41}}']));
        self::assertSame(5_041, $standOff(['status' => 429, 'headers' => ['retry-after' => 'Wed, 21 Oct 2026 07:28:00 GMT'], 'body' => '{"code":429,"data":{"retry_after":41}}']));

        // The path reaches the guard too: a 429 on a create stops creates only.
        $budget = new WeightBudget('ff-test', static fn (): int => 5_000, SwapProviderLimits::lightningSwap());
        $provider = $this->provider([
            ...self::catalogReplies(),
            '/api/v2/create' => ['status' => 429, 'headers' => ['retry-after' => '12'], 'body' => '{"code":429,"msg":"Rate limit","data":null}'],
        ], null, $budget);
        try {
            $provider->createSwap('USDT_TRON', 'lnbc1', 200_000_000);
            self::fail('the 429 did not raise');
        } catch (FixedFloatApiError $e) {
            self::assertSame('create', $e->path);
        }
        self::assertSame(5_012, self::denial(static fn () => $provider->assertCreateAvailable())['backoff_until'] ?? null);
        $budget->assertAvailable('order');
    }

    public function testTheWaitIsReadFromTheHeaderThenTheBody(): void
    {
        self::assertSame(17, FixedFloatProvider::readRetryAfterSeconds(['retry-after' => '17'], null));
        self::assertSame(17, FixedFloatProvider::readRetryAfterSeconds(['Retry-After' => ['17']], ['retry_after' => 41]), 'a list of values, any case');
        self::assertSame(0, FixedFloatProvider::readRetryAfterSeconds(['retry-after' => '0'], ['retry_after' => 41]), 'whole seconds are taken as given; the guard treats zero as no wait');
        self::assertSame(41, FixedFloatProvider::readRetryAfterSeconds([], ['retry_after' => 41]));
        self::assertSame(1.5, FixedFloatProvider::readRetryAfterSeconds(['retry-after' => '1.5'], ['retry_after' => 1.5]), 'digits only in the header');
        self::assertSame(41, FixedFloatProvider::readRetryAfterSeconds(['retry-after' => '1234567890'], ['retry_after' => 41]), 'at most nine digits');
        self::assertNull(FixedFloatProvider::readRetryAfterSeconds(['content-type' => 'application/json'], ['retry_after' => '41']), 'a number, not a string');
        self::assertNull(FixedFloatProvider::readRetryAfterSeconds([], ['retry_after' => 0]));
        self::assertNull(FixedFloatProvider::readRetryAfterSeconds([], ['retry_after' => -3]));
        self::assertNull(FixedFloatProvider::readRetryAfterSeconds([], null));
        self::assertNull(FixedFloatProvider::readRetryAfterSeconds([], 'slow down'));
    }
}
