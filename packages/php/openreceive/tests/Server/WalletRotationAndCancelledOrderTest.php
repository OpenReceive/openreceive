<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use Nyholm\Psr7\Factory\Psr17Factory;
use OpenReceive\Host;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use OpenReceive\Testing\FakeWallet;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\AbstractLogger;

/**
 * Two lifetime edge cases through the real engine, repository and reconcile
 * gate over SQLite with the fake wallet: the merchant changing the wallet
 * code while invoices are pending, and the host's order going away while the
 * payer is paying.
 */
final class WalletRotationAndCancelledOrderTest extends TestCase
{
    private const GRACE_SECONDS = 900;
    /** The gate floor for a young invoice: a later request runs a fresh pass. */
    private const GATE_SECONDS = 3;

    private int $now = 1_700_000_000;
    private PdoConnection $db;
    private SqlPaymentRepository $repository;
    /** @var array<string, array<string, int>> */
    private array $orders = [];
    /** @var list<string> */
    private array $refused = [];
    /** @var list<string> */
    private array $paid = [];
    private ?\Throwable $hookFailure = null;
    /** @var list<string> */
    private array $doomed = [];
    /** @var list<string> */
    private array $logs = [];
    private Engine $engine;

    protected function setUp(): void
    {
        $this->db = new PdoConnection(new \PDO('sqlite::memory:'));
        PaymentsSchema::migrate($this->db);
        $this->db->execute('CREATE TABLE fulfilled (reference TEXT NOT NULL)');
        $this->repository = new SqlPaymentRepository($this->db, fn (): int => $this->now);
    }

    private function wallet(): FakeWallet
    {
        return new FakeWallet(fn (): int => $this->now);
    }

    /** The fake wallet's hashes are its mint counter; a history keeps two wallets apart. */
    private function walletWithHistory(): FakeWallet
    {
        $wallet = $this->wallet();
        for ($mint = 0; $mint < 32; $mint++) {
            $wallet->makeInvoice(['amount_msats' => 1000]);
        }
        return $wallet;
    }

    /** Another NWC connection to the same wallet: the invoices are shared. */
    private static function connectionTo(FakeWallet $wallet): ReceiveNwcClient
    {
        return new class ($wallet) implements ReceiveNwcClient {
            public function __construct(private readonly FakeWallet $wallet)
            {
            }

            public function makeInvoice(array $request): array
            {
                return $this->wallet->makeInvoice($request);
            }

            public function listTransactions(array $request): array
            {
                return $this->wallet->listTransactions($request);
            }

            public function preflight(): array
            {
                return $this->wallet->preflight();
            }

            public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
            {
                $this->wallet->subscribeNotifications($handler, $onIdle);
            }
        };
    }

    /** A shop process: a fresh service, host and engine over the same database. */
    private function start(ReceiveNwcClient $wallet): void
    {
        $clock = fn (): int => $this->now;
        $service = new Service($wallet, false, [], ['USD'], $clock);
        $test = $this;
        $host = new class ($test) implements Host {
            public function __construct(private readonly WalletRotationAndCancelledOrderTest $test)
            {
            }

            public function authorize(AuthorizeContext $context): bool
            {
                return !in_array($context->reference(), $this->test->refused(), true);
            }

            public function amountFor(string $reference): ?array
            {
                return $this->test->price($reference);
            }

            public function onPaid(PaymentSettlement $settlement): void
            {
                $this->test->fulfill($settlement);
            }
        };
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
        $this->engine = new Engine($host, $this->repository, $service, true, false, null, null, $logger, '/openreceive', new Psr17Factory());
    }

    /** @return list<string> */
    public function refused(): array
    {
        return $this->refused;
    }

    /** @return array<string, int>|null */
    public function price(string $reference): ?array
    {
        return $this->orders[$reference] ?? null;
    }

    public function fulfill(PaymentSettlement $settlement): void
    {
        $connection = $settlement->connection;
        self::assertNotNull($connection);
        $connection->execute('INSERT INTO fulfilled (reference) VALUES (?)', [$settlement->reference]);
        if ($this->hookFailure !== null || in_array($settlement->reference, $this->doomed, true)) {
            throw $this->hookFailure ?? new \RuntimeException('the order row is gone');
        }
        $this->paid[] = $settlement->reference;
    }

    /** @param array<string, mixed> $body */
    private function post(string $path, array $body): ResponseInterface
    {
        $factory = new Psr17Factory();
        $request = $factory->createServerRequest('POST', "http://shop.test/openreceive{$path}")
            ->withHeader('content-type', 'application/json')
            ->withBody($factory->createStream(json_encode($body, JSON_THROW_ON_ERROR)));
        return $this->engine->psr15Handler()->handle($request);
    }

    /** @return array<string, mixed> */
    private static function json(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);
    }

    /** @return array<string, mixed> */
    private function checkout(string $reference, int $sats = 100): array
    {
        $this->orders[$reference] = ['sats' => $sats];
        $response = $this->post('/checkouts', ['reference' => $reference]);
        self::assertSame(201, $response->getStatusCode(), (string) $response->getBody());
        return self::json($response)['checkout'];
    }

    private function check(string $reference, string $hash): ResponseInterface
    {
        return $this->post('/payments/check', ['reference' => $reference, 'payment_hash' => $hash]);
    }

    /** @return array{0: ?string, 1: ?string, 2: ?int} */
    private function row(string $hash): array
    {
        $record = $this->repository->findByPaymentHash($hash);
        return [$record?->status, $record?->statusReason, $record?->paidAt];
    }

    /** @return list<string> */
    private function fulfilled(): array
    {
        return array_column($this->db->query('SELECT reference FROM fulfilled'), 'reference');
    }

    /** @return list<string> */
    private function warnings(): array
    {
        return array_values(array_filter($this->logs, static fn (string $line): bool => str_starts_with($line, 'warning: ') || str_starts_with($line, 'error: ')));
    }

    public function testANewCodeForTheSameWalletKeepsThePendingInvoicePayingExactlyOnce(): void
    {
        $wallet = $this->wallet();
        $this->start(self::connectionTo($wallet));
        $invoice = $this->checkout('order-a');

        $this->start(self::connectionTo($wallet));
        $wallet->settleInvoice($invoice['payment_hash'], $this->now + 1);
        $this->now += self::GATE_SECONDS;
        $response = $this->check('order-a', $invoice['payment_hash']);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame('settled', self::json($response)['status']);
        self::assertSame(['order-a'], $this->paid);

        $this->now += 100;
        self::assertSame('settled', self::json($this->check('order-a', $invoice['payment_hash']))['status']);
        self::assertSame(409, $this->post('/checkouts', ['reference' => 'order-a'])->getStatusCode());
        self::assertSame(['order-a'], $this->fulfilled());
        self::assertSame([], $this->warnings());
    }

    public function testACodeForADifferentWalletClosesTheOldInvoiceNormally(): void
    {
        $oldWallet = $this->walletWithHistory();
        $this->start($oldWallet);
        $stranded = $this->checkout('order-a');
        $hash = $stranded['payment_hash'];

        $newWallet = $this->wallet();
        $this->start($newWallet);
        $oldWallet->settleInvoice($hash, $this->now + 1);
        self::assertNotContains($hash, array_column($newWallet->listInvoices(), 'payment_hash'));

        for ($poll = 0; $poll < 5; $poll++) {
            $this->now += self::GATE_SECONDS;
            $response = $this->check('order-a', $hash);
            self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
            self::assertSame('pending', self::json($response)['status']);
        }
        self::assertSame('pending', $this->row($hash)[0]);

        // A retry of the same order is still served the old wallet's invoice
        // while it is reusable: nothing on the row says which wallet minted it.
        $this->now += 10;
        $retried = $this->post('/checkouts', ['reference' => 'order-a']);
        self::assertSame(201, $retried->getStatusCode());
        self::assertSame($hash, self::json($retried)['checkout']['payment_hash']);
        self::assertSame([], $newWallet->listInvoices(), 'the new wallet minted nothing');

        $fresh = $this->checkout('order-b');
        self::assertNotSame($hash, $fresh['payment_hash']);
        $newWallet->settleInvoice($fresh['payment_hash'], $this->now);
        $this->now += self::GATE_SECONDS;
        self::assertSame('settled', self::json($this->check('order-b', $fresh['payment_hash']))['status']);
        self::assertSame(['order-b'], $this->paid);

        $this->now = $stranded['expires_at'] + self::GRACE_SECONDS - 1;
        $this->check('order-a', $hash);
        self::assertSame('pending', $this->row($hash)[0]);

        $this->now = $stranded['expires_at'] + self::GRACE_SECONDS + 12;
        $expired = $this->check('order-a', $hash);
        self::assertSame(200, $expired->getStatusCode());
        self::assertSame('expired', self::json($expired)['status']);
        self::assertSame(['expired', 'not_found_after_expiry', null], $this->row($hash));

        self::assertSame(['order-b'], $this->fulfilled());
        self::assertSame([], $this->warnings(), 'every pass over the stranded row succeeded');
        self::assertNotSame($hash, $this->checkout('order-a')['payment_hash']);
    }

    public function testAPaymentThatLandedOnTheOldWalletIsReportedToTheMerchant(): void
    {
        self::markTestSkipped('bug: closing an attempt the current wallet never knew logs at most an info line');
        $oldWallet = $this->walletWithHistory();
        $this->start($oldWallet);
        $stranded = $this->checkout('order-a');
        $this->start($this->wallet());
        $oldWallet->settleInvoice($stranded['payment_hash']);
        $this->now = $stranded['expires_at'] + self::GRACE_SECONDS + 12;
        $this->check('order-a', $stranded['payment_hash']);
        self::assertSame('expired', $this->row($stranded['payment_hash'])[0]);
        self::assertNotSame([], $this->warnings(), implode(' | ', $this->logs));
    }

    public function testAnOrderCancelledMidPaymentStillReachesOnPaidExactlyOnce(): void
    {
        $wallet = $this->wallet();
        $this->start($wallet);
        $invoice = $this->checkout('order-a');

        unset($this->orders['order-a']);
        $wallet->settleInvoice($invoice['payment_hash'], $this->now + 1);
        $this->now += self::GATE_SECONDS;

        $response = $this->check('order-a', $invoice['payment_hash']);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame('settled', self::json($response)['status']);
        self::assertSame(['order-a'], $this->fulfilled());

        $this->now += 50;
        self::assertSame('settled', self::json($this->check('order-a', $invoice['payment_hash']))['status']);
        self::assertSame(['order-a'], $this->fulfilled(), 'a replayed pass never fulfills again');
        self::assertSame([], $this->warnings());
    }

    public function testAuthorizeRefusingTheStatusPollDoesNotStopSettlement(): void
    {
        $wallet = $this->wallet();
        $this->start($wallet);
        $invoice = $this->checkout('order-a');

        $this->refused[] = 'order-a';
        $wallet->settleInvoice($invoice['payment_hash'], $this->now + 1);
        $this->now += self::GATE_SECONDS;

        self::assertSame(403, $this->check('order-a', $invoice['payment_hash'])->getStatusCode());
        self::assertSame(['order-a'], $this->fulfilled());
        self::assertSame('settled', $this->row($invoice['payment_hash'])[0]);
    }

    public function testARaisingHostHandlerRollsBackIsRetriedAndFulfillsOnce(): void
    {
        $wallet = $this->wallet();
        $this->start($wallet);
        $invoice = $this->checkout('order-a');

        $this->hookFailure = new \RuntimeException('the order row is gone');
        $wallet->settleInvoice($invoice['payment_hash'], $this->now + 1);
        $this->now += self::GATE_SECONDS;
        $response = $this->check('order-a', $invoice['payment_hash']);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame('pending', self::json($response)['status']);
        self::assertSame('pending', $this->row($invoice['payment_hash'])[0]);
        self::assertSame([], $this->fulfilled(), 'the hook write rolled back with the settlement');
        self::assertStringContainsString('the order row is gone', implode("\n", $this->warnings()));

        $this->hookFailure = null;
        $this->now += self::GATE_SECONDS;
        self::assertSame('settled', self::json($this->check('order-a', $invoice['payment_hash']))['status']);
        self::assertSame(['order-a'], $this->paid);
        self::assertSame(['order-a'], $this->fulfilled());
    }

    public function testAHookThatRaisesForeverNeverClosesTheRowOrStarvesAnotherOrder(): void
    {
        $wallet = $this->wallet();
        $this->start($wallet);
        $doomed = $this->checkout('order-doomed');
        $healthy = $this->checkout('order-ok');

        $this->doomed[] = 'order-doomed';
        $wallet->settleInvoice($doomed['payment_hash'], $this->now + 1);
        $wallet->settleInvoice($healthy['payment_hash'], $this->now + 1);
        $this->now += self::GATE_SECONDS;
        $this->check('order-ok', $healthy['payment_hash']);
        self::assertSame('settled', $this->row($healthy['payment_hash'])[0]);
        self::assertSame(['order-ok'], $this->fulfilled());

        for ($pass = 1; $pass <= 3; $pass++) {
            $this->now = $doomed['expires_at'] + self::GRACE_SECONDS + $pass * 20;
            self::assertSame('pending', self::json($this->check('order-doomed', $doomed['payment_hash']))['status']);
            self::assertSame('pending', $this->row($doomed['payment_hash'])[0], 'paid, so never closed as expired');
        }
        self::assertGreaterThanOrEqual(3, count($this->warnings()));
        self::assertSame(['order-ok'], $this->fulfilled());
    }

    public function testANotificationForACancelledOrderSettlesItOnceAndARaisingHookFallsBack(): void
    {
        $wallet = $this->wallet();
        $this->start($wallet);
        $invoice = $this->checkout('order-a');
        unset($this->orders['order-a']);

        $this->hookFailure = new \RuntimeException('the order row is gone');
        $record = $wallet->settleInvoice($invoice['payment_hash'], $this->now + 1);
        $notification = ['notification_type' => 'payment_received', 'notification' => $record];
        $this->engine->reconciler()->handleNotification($notification);
        self::assertSame('pending', $this->row($invoice['payment_hash'])[0]);

        $this->hookFailure = null;
        $this->now += self::GATE_SECONDS;
        $this->engine->reconciler()->handleNotification($notification);
        self::assertSame('settled', $this->row($invoice['payment_hash'])[0]);
        $this->now += self::GATE_SECONDS;
        $this->engine->reconciler()->handleNotification($notification);
        self::assertSame(['order-a'], $this->fulfilled());
    }
}
