<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use Nyholm\Psr7\Factory\Psr17Factory;
use OpenReceive\Host;
use OpenReceive\Http\CallableTransport;
use OpenReceive\Nwc\CachedWalletInfo;
use OpenReceive\PaymentSettlement;
use OpenReceive\Rates\StaticPriceProvider;
use OpenReceive\Server\AuthorizeContext;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use OpenReceive\Testing\FakeWallet;
use OpenReceive\Tests\Support\MemorySharedCache;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\AbstractLogger;

/**
 * A shop with no swap provider configured takes Lightning payments end to end.
 *
 * Every test boots the real service from an environment with no usable
 * LSC_URI_* value (`${LSC_URI_PRIMARY:-}` in Compose and a half-filled .env
 * read as blank, and blank means "not configured") and drives the real
 * HTTP routes with the fake wallet.
 */
final class NoSwapProviderTest extends TestCase
{
    /** 1 sat is below every swap minimum; 2 BTC above every swap maximum. */
    public const ORDERS = ['order-no-swap' => 2_100, 'order-tiny' => 1, 'order-huge' => 200_000_000];

    private int $now = 1_700_000_000;
    private FakeWallet $wallet;
    /** @var list<string> */
    private array $paid = [];
    /** @var list<string> */
    private array $logs = [];
    /** @var list<string> */
    private array $outbound = [];

    /** @return array<string, array{array<string, string>}> */
    public static function environments(): array
    {
        return [
            'no LSC_URI variables' => [[]],
            'LSC_URI_* empty' => [['LSC_URI_PRIMARY' => '', 'LSC_URI_BACKUP' => '']],
            'LSC_URI_* whitespace' => [['LSC_URI_PRIMARY' => '   ', 'LSC_URI_BACKUP' => "\t\n "]],
        ];
    }

    /** @param array<string, string> $env */
    private function shop(array $env): Engine
    {
        $clock = fn (): int => $this->now;
        $this->wallet = new FakeWallet($clock);
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
        // A provider built from the environment would use this transport for
        // its first call; it records and refuses, so a stray provider fails.
        $http = new CallableTransport(function (string $method, string $url): array {
            $this->outbound[] = "{$method} {$url}";
            throw new \RuntimeException("unexpected swap provider call: {$url}");
        });
        $service = new Service($this->wallet, new StaticPriceProvider(), null, ['USD'], $clock, false, $env, $logger, $http);
        self::assertSame([], $service->swapProviders(), 'a blank code builds no provider');
        $db = new PdoConnection(new \PDO('sqlite::memory:'));
        PaymentsSchema::migrate($db);
        $repository = new SqlPaymentRepository($db, $clock);
        $paid = &$this->paid;
        $host = new class ($paid) implements Host {
            /** @param list<string> $paid */
            public function __construct(private array &$paid)
            {
            }

            public function authorize(AuthorizeContext $context): bool
            {
                return true;
            }

            public function amountFor(string $reference): ?array
            {
                // Like a host that closes an order once it is paid.
                if (in_array($reference, $this->paid, true)) {
                    return null;
                }
                return isset(NoSwapProviderTest::ORDERS[$reference]) ? ['sats' => NoSwapProviderTest::ORDERS[$reference]] : null;
            }

            public function onPaid(PaymentSettlement $settlement): void
            {
                $this->paid[] = $settlement->reference;
            }
        };
        return new Engine($host, $repository, $service, true, false, null, null, $logger, '/openreceive', new Psr17Factory());
    }

    /** @param array<string, mixed>|null $body */
    private function call(Engine $engine, string $method, string $path, ?array $body = null): ResponseInterface
    {
        $factory = new Psr17Factory();
        $request = $factory->createServerRequest($method, "http://shop.test/openreceive{$path}", ['REMOTE_ADDR' => '203.0.113.5'])
            ->withHeader('content-type', 'application/json');
        if ($body !== null) {
            $request = $request->withBody($factory->createStream(json_encode($body, JSON_THROW_ON_ERROR)));
        }
        return $engine->psr15Handler()->handle($request);
    }

    /** @return array<string, mixed> */
    private static function json(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);
    }

    /** @return list<string> */
    private function providerComplaints(): array
    {
        return array_values(array_filter($this->logs, static fn (string $line): bool => preg_match('/swap|lsc|provider/i', $line) === 1));
    }

    /** @param array<string, string> $env */
    #[DataProvider('environments')]
    public function testBootLogsNoComplaintAndBuildsNoProvider(array $env): void
    {
        $this->shop($env);
        self::assertSame([], $this->providerComplaints());
    }

    public function testAPaidReferenceAnswersItsReceiptAndRefusesANewAttempt(): void
    {
        $engine = $this->shop([]);
        $created = self::json($this->call($engine, 'POST', '/checkouts', ['reference' => 'order-no-swap']));
        $hash = $created['checkout']['payment_hash'];
        $this->wallet->settleInvoice($hash, $this->now + 1);
        $this->now += 30;

        $response = $this->call($engine, 'POST', '/checkouts/prepare', ['reference' => 'order-no-swap']);
        self::assertSame(200, $response->getStatusCode());
        $prepared = self::json($response);
        self::assertSame(2_100_000, $prepared['amount_msats']);
        self::assertSame([], $prepared['payment_methods']);
        self::assertSame($hash, $prepared['paid']['payment_hash']);
        self::assertSame('lightning', $prepared['paid']['rail']);
        self::assertSame(['order-no-swap'], $this->paid);

        foreach ([['/checkouts', []], ['/swaps', ['pay_in_asset' => 'USDT_TRON']]] as [$route, $extra]) {
            $refused = $this->call($engine, 'POST', $route, ['reference' => 'order-no-swap', ...$extra]);
            self::assertSame(409, $refused->getStatusCode(), $route);
            self::assertSame('This reference is already paid.', self::json($refused)['message']);
        }
        self::assertCount(1, $this->wallet->listInvoices(), 'nothing new was minted');
    }

    /** The quickstart entry point reads the environment itself, so a blank code must not raise. */
    #[DataProvider('environments')]
    public function testFromEnvironmentReadsABlankCodeAsNotConfigured(array $env): void
    {
        $uri = 'nostr+walletconnect://' . str_repeat('a', 64) . '?relay=wss%3A%2F%2Frelay.test&secret=' . str_repeat('b', 64);
        $cache = new MemorySharedCache();
        // No relay is reachable here: the service boots only from the cached wallet info.
        $cache->set(CachedWalletInfo::keyFor($uri), json_encode(['methods' => ['make_invoice', 'list_transactions'], 'encryption' => ['nip44_v2', 'nip04']], JSON_THROW_ON_ERROR), 600);
        $service = Service::fromEnvironment(['NWC_URI' => $uri, ...$env], priceProvider: false, sharedCache: $cache);
        self::assertSame([], $service->swapProviders());
    }

    /** @param array<string, string> $env */
    #[DataProvider('environments')]
    public function testPrepareMintSettleAndThePaidHookFiresOnce(array $env): void
    {
        $engine = $this->shop($env);

        $prepared = self::json($this->call($engine, 'POST', '/checkouts/prepare', ['reference' => 'order-no-swap']));
        self::assertSame(2_100_000, $prepared['amount_msats']);
        self::assertSame([], $prepared['payment_methods']);
        self::assertSame([], $this->wallet->listInvoices(), 'prepare mints nothing');

        $createdResponse = $this->call($engine, 'POST', '/checkouts', ['reference' => 'order-no-swap']);
        self::assertSame(201, $createdResponse->getStatusCode());
        $created = self::json($createdResponse);
        $checkout = $created['checkout'];
        self::assertStringStartsWith('lnbc', $checkout['bolt11']);
        self::assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $checkout['payment_hash']);
        self::assertSame(2_100_000, $checkout['amount_msats']);
        // The wire keeps the (empty) catalog, so a client's picker can stop loading.
        self::assertSame([], $created['payment_methods']);
        self::assertCount(1, $this->wallet->listInvoices());
        self::assertSame(2_100_000, $this->wallet->listInvoices()[0]['amount_msats']);

        $check = ['reference' => 'order-no-swap', 'payment_hash' => $checkout['payment_hash']];
        $pending = self::json($this->call($engine, 'POST', '/payments/check', $check));
        self::assertSame('pending', $pending['status']);
        self::assertSame([], $pending['payment_methods']);

        $this->wallet->settleInvoice($checkout['payment_hash'], $this->now + 1);
        $this->now += 12;
        self::assertSame('settled', self::json($this->call($engine, 'POST', '/payments/check', $check))['status']);
        $this->now += 12;
        self::assertSame('settled', self::json($this->call($engine, 'POST', '/payments/check', $check))['status']);
        self::assertSame(['order-no-swap'], $this->paid, 'the paid hook fires exactly once');
        self::assertSame([], $this->providerComplaints());
    }

    /** @param array<string, string> $env */
    #[DataProvider('environments')]
    public function testAmountsPastAnySwapLimitMintExactly(array $env): void
    {
        $engine = $this->shop($env);
        foreach (['order-tiny' => 1_000, 'order-huge' => 200_000_000_000] as $reference => $msats) {
            $response = $this->call($engine, 'POST', '/checkouts', ['reference' => $reference]);
            self::assertSame(201, $response->getStatusCode(), (string) $response->getBody());
            $created = self::json($response);
            self::assertSame($msats, $created['checkout']['amount_msats']);
            self::assertSame([], $created['payment_methods']);
        }
    }

    /** @param array<string, string> $env */
    #[DataProvider('environments')]
    public function testSwapRoutesRefuseCleanlyAndNeverReachTheWallet(array $env): void
    {
        $engine = $this->shop($env);
        foreach (['/swaps/quote', '/swaps'] as $route) {
            $response = $this->call($engine, 'POST', $route, ['reference' => 'order-no-swap', 'pay_in_asset' => 'USDT_TRON']);
            $body = self::json($response);
            self::assertSame(503, $response->getStatusCode(), json_encode($body, JSON_THROW_ON_ERROR));
            self::assertSame('INTERNAL', $body['code']);
            self::assertSame('No configured swap provider supports USDT_TRON.', $body['message']);
        }
        self::assertSame([], $this->wallet->listInvoices(), 'a refused swap mints no invoice');

        // Status and refund need an attempt to read, so mint one and ask about it.
        $created = self::json($this->call($engine, 'POST', '/checkouts', ['reference' => 'order-no-swap']));
        $hash = $created['checkout']['payment_hash'];
        foreach (['/swaps/status' => [], '/swaps/refunds' => ['refund_address' => 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb']] as $route => $extra) {
            $response = $this->call($engine, 'POST', $route, ['reference' => 'order-no-swap', 'payment_hash' => $hash, ...$extra]);
            $body = self::json($response);
            self::assertSame(404, $response->getStatusCode(), json_encode($body, JSON_THROW_ON_ERROR));
            self::assertSame('NOT_FOUND', $body['code']);
            self::assertSame('The host order has no swap data.', $body['message']);
        }
        self::assertCount(1, $this->wallet->listInvoices(), 'refused swap routes mint nothing');
        self::assertSame([], $this->outbound);
        self::assertSame([], $this->providerComplaints());
    }

    /** @param array<string, string> $env */
    #[DataProvider('environments')]
    public function testRatesAnswerSoACheckoutCannotHang(array $env): void
    {
        $engine = $this->shop($env);
        $response = $this->call($engine, 'GET', '/rates?currencies=USD');
        self::assertSame(200, $response->getStatusCode());
        self::assertArrayHasKey('usd', self::json($response)['bitcoin']);
    }
}
