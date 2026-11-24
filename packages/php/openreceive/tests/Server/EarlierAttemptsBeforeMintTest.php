<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use Nyholm\Psr7\Factory\Psr17Factory;
use OpenReceive\Host;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\PaymentSettlement;
use OpenReceive\Rates\StaticPriceProvider;
use OpenReceive\Server\AuthorizeContext;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use OpenReceive\Testing\FakeSwapProvider;
use OpenReceive\Testing\FakeWallet;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\AbstractLogger;

/**
 * The check before a mint: a create that would mint a new attempt for an order
 * with unpaid ones first walks the wallet for those, and refuses a paid order
 * (409) or a walk that cannot finish (retryable 503). Golden vector 30 pins the
 * Lightning refusal; these cover the swap path, the failure path and when the
 * check must NOT read the wallet. The gate is claimed by hand to stand for the
 * 3 to 12 s between scans, when the request's own gated pass is skipped.
 */
final class EarlierAttemptsBeforeMintTest extends TestCase
{
    private int $now = 1_700_000_000;
    private FakeWallet $wallet;
    private FakeSwapProvider $provider;
    private SqlPaymentRepository $repository;
    private int $historyReads = 0;
    private bool $historyFails = false;
    /** @var list<string> */
    private array $paid = [];
    /** @var list<string> */
    private array $logs = [];

    public function recordPaid(PaymentSettlement $settlement): void
    {
        $this->paid[] = $settlement->paymentHash;
    }

    public function historyRead(): void
    {
        $this->historyReads++;
        if ($this->historyFails) {
            throw new \RuntimeException('relay closed the connection');
        }
    }

    private function engine(): Engine
    {
        $clock = fn (): int => $this->now;
        $this->wallet = new FakeWallet($clock);
        $this->provider = new FakeSwapProvider('fixedfloat', $clock);
        $db = new PdoConnection(new \PDO('sqlite::memory:'));
        PaymentsSchema::migrate($db);
        $this->repository = new SqlPaymentRepository($db, $clock);
        $test = $this;
        $wallet = new class ($this->wallet, $test) implements ReceiveNwcClient {
            public function __construct(private readonly FakeWallet $wallet, private readonly EarlierAttemptsBeforeMintTest $test)
            {
            }

            public function makeInvoice(array $request): array
            {
                return $this->wallet->makeInvoice($request);
            }

            public function listTransactions(array $request): array
            {
                $this->test->historyRead();
                return $this->wallet->listTransactions($request);
            }

            public function preflight(): array
            {
                return $this->wallet->preflight();
            }

            public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
            {
            }
        };
        $host = new class ($test) implements Host {
            public function __construct(private readonly EarlierAttemptsBeforeMintTest $test)
            {
            }

            public function authorize(AuthorizeContext $context): bool
            {
                return true;
            }

            public function amountFor(string $reference): ?array
            {
                return ['sats' => 2100];
            }

            public function onPaid(PaymentSettlement $settlement): void
            {
                $this->test->recordPaid($settlement);
            }
        };
        $service = new Service($wallet, new StaticPriceProvider(), [$this->provider], ['USD'], $clock);
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
        return new Engine($host, $this->repository, $service, true, false, null, null, $logger, '/openreceive', new Psr17Factory());
    }

    /** @param array<string, mixed> $body */
    private function call(Engine $engine, string $path, array $body): ResponseInterface
    {
        $factory = new Psr17Factory();
        $request = $factory->createServerRequest('POST', "http://shop.test/openreceive{$path}")
            ->withHeader('content-type', 'application/json')
            ->withBody($factory->createStream(json_encode($body, JSON_THROW_ON_ERROR)));
        return $engine->psr15Handler()->handle($request);
    }

    /** @return array<string, mixed> */
    private static function json(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);
    }

    /** The shop scanned a moment ago: the next requests' gated pass is skipped. */
    private function closeTheGate(): void
    {
        self::assertNotNull($this->repository->claimReconcileGate($this->now, 60));
    }

    /** @return list<array{0: string, 1: string}> */
    private function attempts(string $reference): array
    {
        return array_map(static fn ($row): array => [$row->paymentHash, $row->status], $this->repository->listForReference($reference));
    }

    public function testAnInvoicePaidJustBeforeThePayerPicksACoinOpensNoProviderOrder(): void
    {
        $engine = $this->engine();
        $invoice = self::json($this->call($engine, '/checkouts', ['reference' => 'order-1']))['checkout']['payment_hash'];
        $this->wallet->settleInvoice($invoice);
        $this->closeTheGate();

        $swap = $this->call($engine, '/swaps', ['reference' => 'order-1', 'pay_in_asset' => 'USDT_TRON']);

        self::assertSame(409, $swap->getStatusCode());
        self::assertSame(['code' => 'CONFLICT', 'message' => 'This reference is already paid.'], array_intersect_key(self::json($swap), ['code' => 1, 'message' => 1]));
        self::assertSame(0, $this->provider->counters()['create_calls'], 'no deposit address for a paid order');
        self::assertSame([[$invoice, 'settled']], $this->attempts('order-1'), 'the payment is recorded and nothing new is minted');
        self::assertSame([$invoice], $this->paid, 'onPaid ran once, from the check');
    }

    public function testACheckThatCannotFinishRefusesAsRetryableThenTheRetryMints(): void
    {
        $engine = $this->engine();
        $invoice = self::json($this->call($engine, '/checkouts', ['reference' => 'order-1']))['checkout']['payment_hash'];
        // 30 s before expiry the invoice is no longer re-served: a create mints.
        $this->now += 570;
        $this->closeTheGate();
        $this->historyFails = true;

        $refused = $this->call($engine, '/checkouts', ['reference' => 'order-1']);

        self::assertSame(503, $refused->getStatusCode());
        $body = self::json($refused);
        self::assertSame('INTERNAL', $body['code']);
        self::assertSame("Could not confirm this order's earlier payment attempt. Please try again in a moment.", $body['message']);
        self::assertTrue($body['retryable']);
        self::assertSame([[$invoice, 'pending']], $this->attempts('order-1'), 'nothing minted blind');
        self::assertCount(1, array_filter($this->logs, static fn (string $line): bool => str_contains($line, 'payment.reconcile.before_mint.failed')));
        self::assertStringNotContainsString('relay closed', (string) $refused->getBody());

        $this->historyFails = false;
        $retried = $this->call($engine, '/checkouts', ['reference' => 'order-1']);
        self::assertSame(201, $retried->getStatusCode(), 'an unpaid earlier invoice lets the retry mint');
        self::assertCount(2, $this->attempts('order-1'));
    }

    public function testReServingALiveInvoiceNeverReadsTheWallet(): void
    {
        $engine = $this->engine();
        $first = self::json($this->call($engine, '/checkouts', ['reference' => 'order-1']))['checkout']['payment_hash'];
        $this->closeTheGate();
        $reads = $this->historyReads;

        $again = self::json($this->call($engine, '/checkouts', ['reference' => 'order-1']))['checkout']['payment_hash'];

        self::assertSame($first, $again);
        self::assertSame($reads, $this->historyReads);
    }

    public function testAnInvoiceThisRequestsOwnPassCheckedIsNotWalkedAgain(): void
    {
        $engine = $this->engine();
        $this->call($engine, '/checkouts', ['reference' => 'order-1']);
        $this->now += 570;
        $reads = $this->historyReads;

        // The gate is open: the request's own pass reads both history views and sees
        // the invoice unpaid, so the check before the mint has nothing left to read.
        self::assertSame(201, $this->call($engine, '/checkouts', ['reference' => 'order-1'])->getStatusCode());

        self::assertSame(2, $this->historyReads - $reads);
    }

    public function testAnInvoiceExpiredMoreThanTenMinutesAgoIsNotChecked(): void
    {
        $engine = $this->engine();
        $this->call($engine, '/checkouts', ['reference' => 'order-1']);
        $this->now += 600 + 600;
        $this->closeTheGate();
        $reads = $this->historyReads;

        self::assertSame(201, $this->call($engine, '/checkouts', ['reference' => 'order-1'])->getStatusCode());

        self::assertSame($reads, $this->historyReads);
    }
}
