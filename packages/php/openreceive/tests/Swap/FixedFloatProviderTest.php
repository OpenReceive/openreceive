<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Swap;

use OpenReceive\Http\CallableTransport;
use OpenReceive\Http\TransportException;
use OpenReceive\Swap\FixedFloatApiError;
use OpenReceive\Swap\FixedFloatProvider;
use OpenReceive\Swap\FixedFloatRates;
use OpenReceive\Swap\Swap;
use OpenReceive\Swap\TransientCache;
use OpenReceive\Swap\WeightBudget;
use OpenReceive\Swap\WeightBudgetError;
use PHPUnit\Framework\TestCase;

final class FixedFloatProviderTest extends TestCase
{
    private const RATES_XML = '<rates><item><from>USDTTRC</from><to>BTCLN</to><in>1 USDTTRC</in><out>0.00001 BTCLN</out><amount>1000</amount><minamount>10 USDTTRC</minamount><maxamount>5000 USDTTRC</maxamount><tofee>0.000001 BTC</tofee></item>'
        . '<item><from>USDTTRC</from><to>BTC</to><in>1</in><out>0.00001</out><amount>1</amount><minamount>1</minamount><maxamount>2</maxamount></item></rates>';

    /** @var list<array{method: string, url: string, headers: array<string, string>, body: ?string}> */
    private array $calls = [];

    /** @param array<string, array{status: int, body: string}|\Throwable> $replies keyed by path suffix */
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
}
