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
use OpenReceive\Testing\FakeWallet;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\AbstractLogger;

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
    private SqlPaymentRepository $repository;

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
        $provider = new FixedFloatProvider('synthetic-key', 'synthetic-secret', 'fixedfloat', 'https://ff.test', null, $transport, $clock);
        $logs = &$this->logs;
        $logger = new class ($logs) extends AbstractLogger {
            /** @param list<string> $lines */
            public function __construct(private array &$lines)
            {
            }

            public function log($level, string|\Stringable $message, array $context = []): void
            {
                $this->lines[] = "{$level}: {$message}";
            }
        };
        $db = new PdoConnection(new \PDO('sqlite::memory:'));
        PaymentsSchema::migrate($db);
        $this->repository = new SqlPaymentRepository($db, $clock);
        $service = new Service(new FakeWallet($clock), false, [$provider], ['USD'], $clock, logger: $logger);
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
        // provider answers, so the third press would pass the 150 create gate.
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
}
