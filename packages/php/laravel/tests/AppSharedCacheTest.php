<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use Illuminate\Cache\ArrayStore;
use Illuminate\Cache\Repository;
use OpenReceive\Http\CallableTransport;
use OpenReceive\Laravel\Cache\AppSharedCache;
use OpenReceive\Server\Service;
use OpenReceive\Swap\FixedFloatProvider;
use OpenReceive\Testing\FakeWallet;
use PHPUnit\Framework\TestCase as PlainTestCase;

final class AppSharedCacheTest extends PlainTestCase
{
    public function testTheNextRequestReadsPricesCatalogsAndRatesFromTheAppCache(): void
    {
        $urls = [];
        $http = new CallableTransport(static function (string $method, string $url) use (&$urls): array {
            $urls[] = parse_url($url, PHP_URL_PATH);
            return match (true) {
                str_ends_with($url, '/api/v2/ccies') => ['status' => 200, 'body' => json_encode(['code' => 0, 'msg' => 'OK', 'data' => ['ccies' => [
                    ['code' => 'USDTTRC', 'coin' => 'USDT', 'network' => 'TRC20', 'recv' => true, 'send' => true],
                    ['code' => 'BTCLN', 'coin' => 'BTC', 'network' => 'Lightning', 'recv' => true, 'send' => true],
                ]]])],
                str_ends_with($url, '/rates/fixed.xml') => ['status' => 200, 'body' => '<rates><item><from>USDTTRC</from><to>BTCLN</to><in>1 USDTTRC</in><out>0.00001 BTCLN</out><amount>1000</amount><minamount>10 USDTTRC</minamount><maxamount>5000 USDTTRC</maxamount><tofee>0.000001 BTC</tofee></item></rates>'],
                default => ['status' => 200, 'body' => json_encode(['bitcoin' => ['usd' => '50000.00']])],
            };
        });
        $store = new Repository(new ArrayStore());
        // What the service provider builds on every request.
        $request = static fn (): Service => new Service(
            new FakeWallet(),
            swapProviders: [new FixedFloatProvider('key', 'secret', 'ff-test', 'https://ff.test', http: $http)],
            env: [],
            http: $http,
            sharedCache: new AppSharedCache($store),
        );

        $request()->prepareCheckout(['amount' => ['currency' => 'USD', 'value' => '7.00']]);
        self::assertSame(['/api/v3/simple/price', '/api/v2/ccies', '/rates/fixed.xml'], $urls);
        $request()->prepareCheckout(['amount' => ['currency' => 'USD', 'value' => '7.00']]);
        self::assertCount(3, $urls, 'the second request fetches nothing');
    }
}
