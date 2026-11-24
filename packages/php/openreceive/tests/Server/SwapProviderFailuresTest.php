<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use Nyholm\Psr7\Factory\Psr17Factory;
use OpenReceive\Host;
use OpenReceive\Http\CallableTransport;
use OpenReceive\Http\TransportException;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use OpenReceive\Swap\FixedFloatProvider;
use OpenReceive\Swap\GuardedSwapProvider;
use OpenReceive\Swap\SwapProvider;
use OpenReceive\Swap\SwapProviderLimits;
use OpenReceive\Swap\SwapProviderRuntime;
use OpenReceive\Swap\TransientCache;
use OpenReceive\Swap\WeightBudget;
use OpenReceive\Testing\FakeWallet;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\AbstractLogger;
use Psr\Log\LoggerInterface;

/**
 * A swap provider call that fails reaches the payer as the 502/503 the swap
 * routes declare (the JS throughProvider), never the opaque 500 "Internal
 * server error." the WooCommerce plugin showed on its USDT step: a refused
 * /create, a provider 429 or outage, and this process's own weight budget,
 * which a payer pressing Try again a few times spends.
 */
final class SwapProviderFailuresTest extends TestCase
{
    private const ORDER = [
        'id' => 'ORD1', 'token' => 'fixture-private-token', 'status' => 'NEW',
        'from' => ['address' => 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', 'amount' => '200.1'],
        'time' => ['expiration' => 1_700_001_800],
    ];

    /** @var array<string, array{status: int, body: string}|\Throwable> */
    private array $replies = [];
    /** @var list<string> */
    private array $calls = [];
    /** @var list<string> */
    private array $logs = [];
    /** @var list<array{level: string, message: string, context: array<string, mixed>}> */
    private array $records = [];
    private SqlPaymentRepository $repository;
    private FakeWallet $wallet;

    /** @return array{status: int, body: string} */
    private static function api(mixed $data, int $code = 0, string $msg = 'OK'): array
    {
        return ['status' => 200, 'body' => json_encode(['code' => $code, 'msg' => $msg, 'data' => $data], JSON_THROW_ON_ERROR)];
    }

    private function engine(): Engine
    {
        $this->replies = [
            'ccies' => self::api(['ccies' => [
                ['code' => 'USDTTRC', 'coin' => 'USDT', 'network' => 'TRC20', 'recv' => true, 'send' => true],
                ['code' => 'BTCLN', 'coin' => 'BTC', 'network' => 'Lightning', 'recv' => true, 'send' => true],
            ]]),
            'create' => self::api(self::ORDER),
            'order' => self::api(self::ORDER),
        ];
        $clock = static fn (): int => 1_700_000_000;
        $transport = new CallableTransport(function (string $method, string $url, array $headers, ?string $body): array {
            $path = substr($url, strrpos($url, '/') + 1);
            $this->calls[] = $path;
            $reply = $this->replies[$path] ?? ['status' => 404, 'body' => ''];
            if ($reply instanceof \Throwable) {
                throw $reply;
            }
            return $reply;
        });
        // FixedFloat's own host, the one the guard counts for; the scripted transport answers.
        $provider = new FixedFloatProvider('synthetic-key', 'synthetic-secret', 'fixedfloat', 'https://ff.io', null, $transport, $clock);
        $logger = $this->logger();
        $db = new PdoConnection(new \PDO('sqlite::memory:'));
        PaymentsSchema::migrate($db);
        $this->repository = new SqlPaymentRepository($db, $clock);
        $this->wallet = new FakeWallet($clock);
        $service = new Service($this->wallet, false, [$provider], ['USD'], $clock, logger: $logger);
        $host = new class implements Host {
            public function authorize(AuthorizeContext $context): bool
            {
                return true;
            }

            public function amountFor(string $reference): ?array
            {
                return ['sats' => 200_000];
            }

            public function onPaid(PaymentSettlement $settlement): void
            {
            }
        };
        return new Engine($host, $this->repository, $service, logger: $logger, responseFactory: new Psr17Factory());
    }

    /** Every line lands in `$this->logs` as "level: message", and in `$this->records` with its context. */
    private function logger(): LoggerInterface
    {
        $logs = &$this->logs;
        $records = &$this->records;
        return new class ($logs, $records) extends AbstractLogger {
            /**
             * @param list<string> $lines
             * @param list<array{level: string, message: string, context: array<string, mixed>}> $records
             */
            public function __construct(private array &$lines, private array &$records)
            {
            }

            public function log($level, string|\Stringable $message, array $context = []): void
            {
                $this->lines[] = "{$level}: {$message}";
                $this->records[] = ['level' => (string) $level, 'message' => (string) $message, 'context' => $context];
            }
        };
    }

    /** @return list<array{level: string, message: string, context: array<string, mixed>}> */
    private function rateLimitLines(): array
    {
        return array_values(array_filter($this->records, static fn (array $record): bool => str_starts_with($record['message'], 'swap.provider.rate_limited: ')));
    }

    /** @param array<string, mixed> $body @return array{0: int, 1: array<string, mixed>} */
    private function post(Engine $engine, string $path, array $body): array
    {
        $factory = new Psr17Factory();
        $request = $factory->createServerRequest('POST', "http://shop.test/openreceive{$path}", ['REMOTE_ADDR' => '203.0.113.5'])
            ->withHeader('content-type', 'application/json')
            ->withBody($factory->createStream(json_encode($body, JSON_THROW_ON_ERROR)));
        $response = $engine->psr15Handler()->handle($request);
        return [$response->getStatusCode(), self::json($response)];
    }

    /** @return array<string, mixed> */
    private static function json(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);
    }

    /** @return array{0: int, 1: array<string, mixed>} */
    private function createSwap(Engine $engine): array
    {
        return $this->post($engine, '/swaps', ['reference' => 'order-swap', 'pay_in_asset' => 'USDT_TRON']);
    }

    public function testARefusedCreateIsA502WithThePayerSentence(): void
    {
        $engine = $this->engine();
        $this->replies['create'] = self::api(null, 1, 'Order could not be created');
        [$status, $body] = $this->createSwap($engine);
        self::assertSame(502, $status, json_encode($body, JSON_THROW_ON_ERROR));
        self::assertSame(['code', 'message', 'request_id'], array_keys($body));
        self::assertSame('INTERNAL', $body['code']);
        self::assertSame('The swap provider refused this request.', $body['message']);
        // The invoice minted for the swap is withheld: no attempt row exists.
        self::assertSame([], $this->repository->listForReference('order-swap'));
        // The operator still reads the provider's own words; the payer never does.
        self::assertStringContainsString('Order could not be created', implode("\n", $this->logs));
    }

    public function testTheWeightBudgetAfterAFewTryAgainsIsARetryable503(): void
    {
        $engine = $this->engine();
        $this->replies['create'] = self::api(null, 1, 'Order could not be created');
        // /ccies spent 1 and each Try again spends a create weight (50) before the
        // provider answers, so the fourth press would pass the 200 soft cap.
        self::assertSame(502, $this->createSwap($engine)[0]);
        self::assertSame(502, $this->createSwap($engine)[0]);
        self::assertSame(502, $this->createSwap($engine)[0]);
        $creates = count(array_keys($this->calls, 'create', true));
        [$status, $body] = $this->createSwap($engine);
        self::assertSame(503, $status, json_encode($body, JSON_THROW_ON_ERROR));
        self::assertSame('INTERNAL', $body['code']);
        self::assertSame('The swap provider is rate limited. Please try again shortly.', $body['message']);
        self::assertTrue($body['retryable']);
        self::assertSame($creates, count(array_keys($this->calls, 'create', true)), 'the budget refused before the provider');
    }

    /** @return iterable<string, array{0: array{status: int, body: string}|\Throwable, 1: string}> */
    public static function outages(): iterable
    {
        yield 'provider 429' => [['status' => 429, 'body' => '{"code":429,"msg":"Too many requests"}'], 'The swap provider is rate limited. Please try again shortly.'];
        yield 'provider 502' => [['status' => 502, 'body' => 'bad gateway'], 'The swap provider is temporarily unreachable. Please try again shortly.'];
        yield 'connection refused' => [new TransportException('connection refused'), 'The swap provider is temporarily unreachable. Please try again shortly.'];
        yield 'timeout' => [new TransportException('timed out', true), 'The swap provider is temporarily unreachable. Please try again shortly.'];
    }

    /** @param array{status: int, body: string}|\Throwable $reply */
    #[\PHPUnit\Framework\Attributes\DataProvider('outages')]
    public function testAProviderOutageOr429IsARetryable503(array|\Throwable $reply, string $message): void
    {
        $engine = $this->engine();
        $this->replies['create'] = $reply;
        [$status, $body] = $this->createSwap($engine);
        self::assertSame(503, $status, json_encode($body, JSON_THROW_ON_ERROR));
        self::assertSame('INTERNAL', $body['code']);
        self::assertSame($message, $body['message']);
        self::assertTrue($body['retryable']);
    }

    public function testStatusAndRefundCallsMapTheSameWay(): void
    {
        $engine = $this->engine();
        [$status, $body] = $this->createSwap($engine);
        self::assertSame(201, $status, json_encode($body, JSON_THROW_ON_ERROR));
        $hash = $body['swap']['payment_hash'];
        $this->replies['order'] = self::api(null, 1, 'Order not found');
        [$status, $body] = $this->post($engine, '/swaps/status', ['reference' => 'order-swap', 'payment_hash' => $hash]);
        self::assertSame(502, $status);
        self::assertSame('The swap provider refused this request.', $body['message']);
        $this->replies['order'] = ['status' => 503, 'body' => ''];
        [$status, $body] = $this->post($engine, '/swaps/refunds', ['reference' => 'order-swap', 'payment_hash' => $hash, 'refund_address' => 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf']);
        self::assertSame(503, $status);
        self::assertTrue($body['retryable']);
    }

    public function testACreateTheGuardWouldRefuseIsRefusedBeforeAnInvoiceIsMade(): void
    {
        $engine = $this->engine();
        $this->replies['create'] = self::api(null, 1, 'Order could not be created');
        // /ccies spent 1 and each refused create 50, so a fourth create would pass the 200 soft cap.
        self::assertSame(502, $this->createSwap($engine)[0]);
        self::assertSame(502, $this->createSwap($engine)[0]);
        self::assertSame(502, $this->createSwap($engine)[0]);
        self::assertCount(3, $this->wallet->listInvoices(), 'a create the provider answers needs its invoice first');
        $creates = count(array_keys($this->calls, 'create', true));
        for ($attempt = 0; $attempt < 2; $attempt++) {
            [$status, $body] = $this->createSwap($engine);
            self::assertSame(503, $status, json_encode($body, JSON_THROW_ON_ERROR));
            self::assertSame('The swap provider is rate limited. Please try again shortly.', $body['message']);
            self::assertTrue($body['retryable']);
        }
        self::assertCount(3, $this->wallet->listInvoices(), 'a refused swap made no invoice');
        self::assertSame($creates, count(array_keys($this->calls, 'create', true)), 'and reached no provider');
        self::assertSame([], $this->repository->listForReference('order-swap'));
        // Two refusals, one log line: status polls must not bury the log.
        $lines = $this->rateLimitLines();
        self::assertCount(1, $lines);
        self::assertSame('warning', $lines[0]['level']);
        self::assertSame('swap.provider.rate_limited: Swap provider call refused locally: this process reached the per-minute limit it keeps for FixedFloat.', $lines[0]['message']);
        self::assertSame(['provider' => 'fixedfloat', 'path' => 'create', 'reason' => 'exhausted', 'used' => 151, 'gate' => 200], $lines[0]['context']);
    }

    public function testARateRefusalIsLoggedOnceAMinutePerCauseAndAnUnguardedProviderIsNotAsked(): void
    {
        $now = 1_700_000_000;
        $clock = static function () use (&$now): int {
            return $now;
        };
        // A custom provider: it takes the guard the service attaches and answers the check from it.
        $guarded = new class implements SwapProvider, SwapProviderRuntime, GuardedSwapProvider {
            public ?WeightBudget $budget = null;
            public int $creates = 0;
            public function name(): string { return 'ff-io'; }
            public function supportedPayInAssets(): array { return ['USDT_TRON']; }
            public function payInAssetCatalog(): array { return []; }
            public function invoiceExpirySeconds(?string $payInAsset = null): int { return 1800; }
            public function quote(string $payInAsset, int $invoiceAmountMsats): array { throw new \LogicException('not quoted'); }
            public function createSwap(string $payInAsset, string $bolt11, int $invoiceAmountMsats): array
            {
                $this->creates++;
                throw new \LogicException('the provider must not be asked');
            }
            public function getStatus(array $order): array { throw new \LogicException('not polled'); }
            public function requestRefund(array $order, string $refundAddress): void {}
            public function attachSwapCache(TransientCache $cache): void {}
            public function attachWeightBudget(WeightBudget $budget): void { $this->budget = $budget; }
            public function limits(): SwapProviderLimits { return SwapProviderLimits::fixedFloat(); }
            public function assertCreateAvailable(): void { $this->budget?->assertAvailable('create'); }
        };
        $wallet = new FakeWallet($clock);
        $service = new Service($wallet, false, [$guarded], ['USD'], $clock, logger: $this->logger());
        $budget = $guarded->budget;
        self::assertNotNull($budget);
        self::assertSame('fixedfloat', $budget->limits()->profile, 'the service builds the guard from the provider\'s limits');
        $refuse = static function (Service $service): void {
            try {
                $service->createSwap(['reference' => 'order-busy', 'amount' => ['sats' => 20_000], 'pay_in_asset' => 'USDT_TRON']);
                self::fail('the swap was not refused');
            } catch (\OpenReceive\Server\Errors\ServiceError $error) {
                self::assertSame(503, $error->status);
                self::assertSame('The swap provider is rate limited. Please try again shortly.', $error->getMessage());
                self::assertTrue($error->retryable);
            }
        };
        for ($i = 0; $i < 4; $i++) {
            $budget->reserve('create');
        }
        $refuse($service);
        $refuse($service);
        self::assertCount(1, $this->rateLimitLines());
        self::assertSame(
            "swap.provider.rate_limited: Swap provider call refused locally: this process reached the per-minute limit it keeps for FixedFloat.",
            $this->rateLimitLines()[0]['message'],
        );
        self::assertSame(
            ['provider' => 'ff-io', 'path' => 'create', 'reason' => 'exhausted', 'used' => 200, 'gate' => 200],
            $this->rateLimitLines()[0]['context'],
        );
        // Another cause is its own line: the provider's 429 started a stand-off.
        $budget->markRateLimited('create', 200);
        $refuse($service);
        $refuse($service);
        $lines = $this->rateLimitLines();
        self::assertCount(2, $lines);
        self::assertSame("swap.provider.rate_limited: Swap provider call refused locally: standing off after the provider's 429.", $lines[1]['message']);
        self::assertSame('backoff', $lines[1]['context']['reason']);
        self::assertSame($now + 200, $lines[1]['context']['backoff_until']);
        // The same cause is said again a minute later, not before.
        $now += 59;
        $refuse($service);
        self::assertCount(2, $this->rateLimitLines());
        $now += 1;
        $refuse($service);
        self::assertCount(3, $this->rateLimitLines());
        self::assertSame([], $wallet->listInvoices(), 'no refused swap made an invoice');
        self::assertSame(0, $guarded->creates);

        // A provider without the check is not asked: its create makes the invoice, then reserves.
        $this->records = [];
        $unguarded = new class implements SwapProvider, SwapProviderRuntime {
            public ?WeightBudget $budget = null;
            public function name(): string { return 'custom'; }
            public function supportedPayInAssets(): array { return ['USDT_TRON']; }
            public function payInAssetCatalog(): array { return []; }
            public function invoiceExpirySeconds(?string $payInAsset = null): int { return 1800; }
            public function quote(string $payInAsset, int $invoiceAmountMsats): array { throw new \LogicException('not quoted'); }
            public function createSwap(string $payInAsset, string $bolt11, int $invoiceAmountMsats): array
            {
                $this->budget?->reserve('create');
                throw new \LogicException('the spent guard must refuse this create');
            }
            public function getStatus(array $order): array { throw new \LogicException('not polled'); }
            public function requestRefund(array $order, string $refundAddress): void {}
            public function attachSwapCache(TransientCache $cache): void {}
            public function attachWeightBudget(WeightBudget $budget): void { $this->budget = $budget; }
        };
        $wallet = new FakeWallet($clock);
        $service = new Service($wallet, false, [$unguarded], ['USD'], $clock, logger: $this->logger());
        self::assertSame('provider-only', $unguarded->budget?->limits()->profile, 'a provider that states no limits is never counted locally');
        for ($i = 0; $i < 500; $i++) {
            $unguarded->budget?->reserve('create');
        }
        // Only the provider's own 429 stops it.
        $unguarded->budget?->markRateLimited('create', 30);
        $refuse($service);
        self::assertCount(1, $wallet->listInvoices());
        self::assertCount(1, $this->rateLimitLines());
        self::assertSame(
            ['provider' => 'custom', 'path' => 'create', 'reason' => 'backoff', 'backoff_until' => $now + 30],
            $this->rateLimitLines()[0]['context'],
        );
    }

    public function testAProvider429IsLoggedOnceAMinuteWithTheProvidersOwnWords(): void
    {
        $engine = $this->engine();
        $this->replies['create'] = ['status' => 429, 'headers' => ['retry-after' => '90'], 'body' => '{"code":429,"msg":"Too many requests"}'];
        self::assertSame(503, $this->createSwap($engine)[0]);
        $lines = $this->rateLimitLines();
        self::assertCount(1, $lines);
        self::assertSame('swap.provider.rate_limited: The swap provider answered 429 (rate limited); new calls stand off until its wait is over.', $lines[0]['message']);
        self::assertStringContainsString('Too many requests', $lines[0]['context']['error']);
        // The next press is refused by the stand-off the 429 started, for the wait it named.
        self::assertSame(503, $this->createSwap($engine)[0]);
        $lines = $this->rateLimitLines();
        self::assertCount(2, $lines);
        self::assertSame(['provider' => 'fixedfloat', 'path' => 'create', 'reason' => 'backoff', 'used' => 0, 'gate' => 200, 'backoff_until' => 1_700_000_090], $lines[1]['context']);
        self::assertCount(1, $this->wallet->listInvoices(), 'only the create the provider answered made an invoice');
    }
}
