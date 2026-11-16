<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use OpenReceive\Http\CallableTransport;
use OpenReceive\Server\Errors\ServiceError;
use OpenReceive\Server\Service;
use OpenReceive\Support\SharedCache;
use OpenReceive\Swap\FixedFloatProvider;
use OpenReceive\Swap\WeightBudget;
use OpenReceive\Testing\FakeWallet;
use OpenReceive\Tests\Support\MemorySharedCache;
use PHPUnit\Framework\TestCase;
use Psr\Log\AbstractLogger;

/**
 * PHP builds the service, the provider and its request guard again for every
 * request. A provider's 429 says "wait", so the stand-off (and nothing else)
 * is kept in the SharedCache: the next request refuses a new swap before an
 * invoice is made and before the provider is asked again.
 */
final class SwapStandOffAcrossRequestsTest extends TestCase
{
    private const LIGHTNING_SWAP = 'https://lightning-swap.com';
    private const FIXEDFLOAT = 'https://ff.test';
    private const KEY = 'openreceive:swap_backoff:swap';
    private const RATE_LIMITED = 'The swap provider is rate limited. Please try again shortly.';
    // Both sides' USD values are present, so a create needs no /price call.
    private const ORDER = [
        'id' => 'ORD1', 'token' => 'fixture-private-token', 'status' => 'NEW',
        'from' => ['address' => 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', 'amount' => '200.1', 'usd' => '200.10'],
        'to' => ['usd' => '199.00'],
        'time' => ['expiration' => 1_700_001_800],
    ];
    private const STORED_ORDER = [
        'provider' => 'swap', 'provider_order_id' => 'ORD1', 'provider_token' => 'fixture-private-token', 'pay_in_asset' => 'USDT_TRON',
        'deposit_address' => 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', 'deposit_amount' => '200.1', 'expires_at' => 1_700_001_800, 'state' => 'awaiting_deposit',
    ];

    private int $now = 1_700_000_000;
    /** @var array<string, array{status: int, body: string, headers?: array<string, string>}> */
    private array $replies = [];
    /** @var list<string> the provider API paths called, by every request */
    private array $calls = [];
    /** @var list<array{message: string, context: array<string, mixed>}> */
    private array $warnings = [];
    private MemorySharedCache $cache;
    /** The wallet of the request made last. */
    private FakeWallet $wallet;

    protected function setUp(): void
    {
        $this->cache = new MemorySharedCache();
        $this->replies = [
            'ccies' => self::api(['ccies' => [
                ['code' => 'USDTTRC', 'coin' => 'USDT', 'network' => 'TRC20', 'recv' => true, 'send' => true],
                ['code' => 'BTCLN', 'coin' => 'BTC', 'network' => 'Lightning', 'recv' => true, 'send' => true],
            ]]),
            'create' => self::api(self::ORDER),
            'order' => self::api(self::ORDER),
        ];
    }

    /** @return array{status: int, body: string} */
    private static function api(mixed $data): array
    {
        return ['status' => 200, 'body' => json_encode(['code' => 0, 'msg' => 'OK', 'data' => $data], JSON_THROW_ON_ERROR)];
    }

    /** @return array{status: int, body: string, headers?: array<string, string>} */
    private static function tooManyRequests(?int $retryAfter = null): array
    {
        $reply = ['status' => 429, 'body' => '{"code":429,"msg":"Rate limit","data":null}'];
        return $retryAfter === null ? $reply : [...$reply, 'headers' => ['retry-after' => (string) $retryAfter]];
    }

    /** One request: a new provider, guard, wallet and service. Only the cache is the one the last request used. */
    private function request(string $baseUrl, SharedCache|false|null $cache = null): Service
    {
        $clock = fn (): int => $this->now;
        $transport = new CallableTransport(function (string $method, string $url) {
            $path = substr($url, strrpos($url, '/') + 1);
            $this->calls[] = $path;
            return $this->replies[$path] ?? ['status' => 404, 'body' => ''];
        });
        $warnings = &$this->warnings;
        $logger = new class ($warnings) extends AbstractLogger {
            /** @param list<array{message: string, context: array<string, mixed>}> $warnings */
            public function __construct(private array &$warnings)
            {
            }

            public function log($level, string|\Stringable $message, array $context = []): void
            {
                if ($level === 'warning') {
                    $this->warnings[] = ['message' => (string) $message, 'context' => $context];
                }
            }
        };
        $this->wallet = new FakeWallet($clock);
        $provider = new FixedFloatProvider('synthetic-key', 'synthetic-secret', 'swap', $baseUrl, null, $transport, $clock);
        return new Service($this->wallet, false, [$provider], ['USD'], $clock, env: [], logger: $logger, sharedCache: $cache === false ? null : ($cache ?? $this->cache));
    }

    /** Null when the swap was created; the error the payer is answered with when it was not. */
    private function createSwap(Service $service): ?ServiceError
    {
        try {
            $service->createSwap(['reference' => 'order-1', 'amount' => ['sats' => 200_000], 'pay_in_asset' => 'USDT_TRON']);
            return null;
        } catch (ServiceError $error) {
            return $error;
        }
    }

    private function swapStatus(Service $service): ?ServiceError
    {
        try {
            $service->getSwap('order-1', str_repeat('a', 64), ['version' => 1, 'provider_order' => self::STORED_ORDER]);
            return null;
        } catch (ServiceError $error) {
            return $error;
        }
    }

    private static function assertRateLimited(?ServiceError $error, string $message = ''): void
    {
        self::assertNotNull($error, $message);
        self::assertSame(503, $error->status, $message);
        self::assertSame('INTERNAL', $error->errorCode, $message);
        self::assertSame(self::RATE_LIMITED, $error->getMessage(), $message);
        self::assertTrue($error->retryable, $message);
    }

    /** @return array<string, mixed> */
    private function storedStandOff(): array
    {
        return json_decode($this->cache->entries[self::KEY]['value'], true, 512, JSON_THROW_ON_ERROR);
    }

    public function testARefusedCreateIsRememberedSoTheNextRequestMakesNoInvoiceAndAsksNoProvider(): void
    {
        self::assertSame(self::KEY, WeightBudget::sharedKey('swap'));
        // Request one: the provider refuses the create and names its wait.
        $this->replies['create'] = self::tooManyRequests(30);
        self::assertRateLimited($this->createSwap($this->request(self::LIGHTNING_SWAP)));
        self::assertSame(['ccies', 'create'], $this->calls);
        self::assertCount(1, $this->wallet->listInvoices(), 'the create the provider answered had its invoice');
        self::assertSame(['create_backoff_until' => $this->now + 30], $this->storedStandOff());
        self::assertSame(31, $this->cache->entries[self::KEY]['ttl']);

        // Request two would be accepted by the provider now, but it said to wait.
        $this->replies['create'] = self::api(self::ORDER);
        $this->warnings = [];
        $second = $this->request(self::LIGHTNING_SWAP);
        self::assertRateLimited($this->createSwap($second));
        self::assertSame([], $this->wallet->listInvoices(), 'refused before an invoice was made');
        self::assertSame(['ccies', 'create'], $this->calls, 'and before any provider call');
        // The same denial the process that was told gives: a stand-off, and when it ends.
        self::assertCount(1, $this->warnings);
        self::assertSame("swap.provider.rate_limited: Swap provider call refused locally: standing off after the provider's 429.", $this->warnings[0]['message']);
        self::assertSame('backoff', $this->warnings[0]['context']['reason']);
        self::assertSame('create', $this->warnings[0]['context']['path']);
        self::assertSame($this->now + 30, $this->warnings[0]['context']['backoff_until']);

        // Lightning Swap counts new swaps apart: a swap that exists is still read, by this request and the next.
        self::assertNull($this->swapStatus($second));
        self::assertNull($this->swapStatus($this->request(self::LIGHTNING_SWAP)));
        self::assertSame(['ccies', 'create', 'order', 'order'], $this->calls);

        // Still waiting one second before the end; allowed when the wait is over.
        $this->now += 29;
        self::assertRateLimited($this->createSwap($this->request(self::LIGHTNING_SWAP)));
        self::assertSame([], $this->wallet->listInvoices());
        $this->now += 1;
        self::assertNull($this->createSwap($this->request(self::LIGHTNING_SWAP)));
        self::assertCount(1, $this->wallet->listInvoices());
        self::assertSame(['ccies', 'create', 'order', 'order', 'create'], $this->calls);
    }

    public function testAFixedFloatStandOffStopsEveryCallOfTheNextRequest(): void
    {
        // No wait named: FixedFloat's minute, for every call.
        $this->replies['create'] = self::tooManyRequests();
        self::assertRateLimited($this->createSwap($this->request(self::FIXEDFLOAT)));
        self::assertSame(['backoff_until' => $this->now + 60], $this->storedStandOff());
        self::assertSame(61, $this->cache->entries[self::KEY]['ttl']);
        $calls = $this->calls;

        $this->replies['create'] = self::api(self::ORDER);
        $second = $this->request(self::FIXEDFLOAT);
        self::assertRateLimited($this->createSwap($second), 'create');
        self::assertRateLimited($this->swapStatus($second), 'status');
        self::assertRateLimited($this->swapStatus($this->request(self::FIXEDFLOAT)), 'status in a third request');
        self::assertSame([], $this->wallet->listInvoices());
        self::assertSame($calls, $this->calls, 'no request asked the provider during the stand-off');

        $this->now += 60;
        $after = $this->request(self::FIXEDFLOAT);
        self::assertNull($this->swapStatus($after));
        self::assertNull($this->createSwap($after));
        self::assertSame([...$calls, 'order', 'create'], $this->calls);
    }

    public function testThreeCreatesInOneRequestDoNotCountAgainstTheNext(): void
    {
        // The catalog is already in the shared cache, so the creates are the only weight spent.
        $this->request(self::FIXEDFLOAT)->swapProviders()[0]->supportedPayInAssets();
        $busy = $this->request(self::FIXEDFLOAT);
        for ($i = 0; $i < 3; $i++) {
            self::assertNull($this->createSwap($busy), "create {$i}");
        }
        // The fourth is this process's own per-minute limit...
        self::assertRateLimited($this->createSwap($busy));
        self::assertSame('exhausted', end($this->warnings)['context']['reason']);
        self::assertSame(['ccies', 'create', 'create', 'create'], $this->calls);
        self::assertArrayNotHasKey(self::KEY, $this->cache->entries, 'which is not a stand-off and is never stored');
        self::assertSame(['openreceive:swap_limits:swap'], array_keys($this->cache->entries));
        // ...and not the next request's: counts are not shared.
        $next = $this->request(self::FIXEDFLOAT);
        self::assertNull($this->createSwap($next));
        self::assertNull($this->createSwap($next));
        self::assertSame(['ccies', 'create', 'create', 'create', 'create', 'create'], $this->calls);
    }

    public function testACacheThatThrowsChangesNothing(): void
    {
        foreach (['reads' => [true, false], 'writes' => [false, true], 'both' => [true, true]] as $name => [$failReads, $failWrites]) {
            $this->calls = [];
            $this->now += 1_000;
            $cache = new class ($failReads, $failWrites) implements SharedCache {
                /** @var array<string, string> */
                private array $entries = [];

                public function __construct(private readonly bool $failReads, private readonly bool $failWrites)
                {
                }

                public function get(string $key): ?string
                {
                    if ($this->failReads) {
                        throw new \RuntimeException('the cache is down');
                    }
                    return $this->entries[$key] ?? null;
                }

                public function set(string $key, string $value, int $ttlSeconds): void
                {
                    if ($this->failWrites) {
                        throw new \RuntimeException('the cache is read-only');
                    }
                    $this->entries[$key] = $value;
                }
            };
            // A working swap is not disturbed.
            $this->replies['create'] = self::api(self::ORDER);
            self::assertNull($this->createSwap($this->request(self::LIGHTNING_SWAP, $cache)), $name);
            // A 429 is the payer's retryable 503, not the cache's exception.
            $this->replies['create'] = self::tooManyRequests(30);
            $told = $this->request(self::LIGHTNING_SWAP, $cache);
            self::assertRateLimited($this->createSwap($told), $name);
            // The process that was told stands off in its own memory, as before.
            $calls = count($this->calls);
            self::assertRateLimited($this->createSwap($told), $name);
            self::assertCount($calls, $this->calls, $name);
            // The next request never learned of it: it asks the provider, as before.
            $this->replies['create'] = self::api(self::ORDER);
            self::assertNull($this->createSwap($this->request(self::LIGHTNING_SWAP, $cache)), $name);
            self::assertSame('create', end($this->calls), $name);
        }
    }

    public function testAStoredStandOffTooFarInTheFutureOrUnreadableIsIgnored(): void
    {
        // Lightning Swap's longest stand-off is five minutes.
        foreach ([
            json_encode(['create_backoff_until' => $this->now + 301, 'backoff_until' => $this->now + 86_400]),
            'not json',
            '{"create_backoff_until":"soon","backoff_until":true}',
            json_encode(['create_backoff_until' => $this->now - 1, 'backoff_until' => $this->now]),
        ] as $value) {
            $this->cache->entries[self::KEY] = ['value' => (string) $value, 'ttl' => 60];
            $service = $this->request(self::LIGHTNING_SWAP);
            self::assertNull($this->createSwap($service), (string) $value);
            self::assertNull($this->swapStatus($service), (string) $value);
        }
        // One within the bound is a stand-off.
        $this->cache->entries[self::KEY] = ['value' => (string) json_encode(['create_backoff_until' => $this->now + 300]), 'ttl' => 301];
        self::assertRateLimited($this->createSwap($this->request(self::LIGHTNING_SWAP)));
    }

    public function testWithoutASharedCacheTheNextRequestAsksTheProviderAsBefore(): void
    {
        $this->replies['create'] = self::tooManyRequests(30);
        self::assertRateLimited($this->createSwap($this->request(self::LIGHTNING_SWAP, false)));
        self::assertRateLimited($this->createSwap($this->request(self::LIGHTNING_SWAP, false)));
        self::assertSame(['ccies', 'create', 'ccies', 'create'], $this->calls, 'each request asked the provider');
        self::assertCount(1, $this->wallet->listInvoices());
        self::assertSame([], $this->cache->entries);
    }

    public function testTheStandOffIsReadOnlyWhereAProviderCallIsAboutToBeMade(): void
    {
        $cache = new class implements SharedCache {
            /** @var list<string> */
            public array $reads = [];
            /** @var array<string, string> */
            private array $entries = [];

            public function get(string $key): ?string
            {
                $this->reads[] = $key;
                return $this->entries[$key] ?? null;
            }

            public function set(string $key, string $value, int $ttlSeconds): void
            {
                $this->entries[$key] = $value;
            }
        };
        $standOffReads = static fn (): int => count(array_keys($cache->reads, self::KEY, true));
        // The first request fetches the catalog: one provider call, one read before it.
        $this->request(self::FIXEDFLOAT, $cache)->listSwapOptions(200_000_000);
        self::assertSame(['ccies'], array_values(array_filter($this->calls, static fn (string $path): bool => $path !== 'fixed.xml')));
        self::assertSame(1, $standOffReads());
        // Building the service and listing the methods from the cached catalog asks no provider and reads no stand-off.
        $service = $this->request(self::FIXEDFLOAT, $cache);
        $service->listSwapOptions(200_000_000);
        $service->prepareCheckout(['amount' => ['sats' => 200_000]]);
        self::assertSame(1, $standOffReads());
        // A create reads it: once to refuse early, once more for the call itself.
        self::assertNull($this->createSwap($service));
        self::assertSame(3, $standOffReads());
        // A status poll reads it once, before its one call.
        self::assertNull($this->swapStatus($service));
        self::assertSame(4, $standOffReads());
    }
}
