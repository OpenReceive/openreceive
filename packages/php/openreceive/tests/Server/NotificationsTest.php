<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Server\Notifications;
use OpenReceive\Server\Reconciler;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use PHPUnit\Framework\TestCase;

final class NotificationsTest extends TestCase
{
    public function testDisconnectedSubscriptionsKeepPeriodicRecoveryAndCancelDuringBackoff(): void
    {
        $elapsed = 0;
        $client = new class implements ReceiveNwcClient {
            public int $scans = 0;
            public int $subscriptions = 0;
            public bool $stopped = false;
            public function makeInvoice(array $request): array { throw new \LogicException('not used'); }
            public function listTransactions(array $request): array { $this->scans++; return ['transactions' => []]; }
            public function preflight(): array { return ['methods' => ['make_invoice', 'list_transactions'], 'encryption' => ['nip04']]; }
            public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void {
                $this->subscriptions++;
                // No idle callback arrives from an unavailable subscription.
                throw new \RuntimeException('every relay is offline');
            }
            public function stopNotifications(): void { $this->stopped = true; }
        };
        $clock = static function () use (&$elapsed): int { return 1000 + $elapsed; };
        $db = new PdoConnection(new \PDO('sqlite::memory:'));
        PaymentsSchema::migrate($db);
        $repository = new SqlPaymentRepository($db, $clock);
        $hash = str_repeat('a', 64);
        $repository->commitAttempt('offline', $hash, ['reference' => 'offline', 'payment_hash' => $hash,
            'bolt11' => 'lnbc-test', 'amount_msats' => 1000, 'created_at' => 1000, 'expires_at' => 9999, 'fiat_quote' => null]);
        $service = new Service($client, false, [], clock: $clock);
        $reconciler = new Reconciler($service, $repository, static function (): void {}, clock: $clock);
        $worker = null;
        $worker = new Notifications($service, $reconciler, 5, sleep: static function (int $seconds) use (&$elapsed, &$worker): void {
            $elapsed += $seconds;
            if ($elapsed >= 16) $worker->stop();
        }, monotonic: static function () use (&$elapsed): float { return (float) $elapsed; });
        $worker->run();
        self::assertSame(16, $elapsed, 'stop interrupts the long reconnect backoff');
        self::assertSame(5, $client->subscriptions);
        self::assertGreaterThanOrEqual(6, $client->scans, 'periodic history scans run without subscription idle ticks');
        self::assertTrue($client->stopped);
        $worker->run();
        self::assertSame(5, $client->subscriptions, 'shutdown never resubscribes');
    }

    public function testTheRetryRampDoublesToTheCapAndResetsAfterAHealthySubscription(): void
    {
        self::assertSame(1, Reconciler::notificationsRetryDelay(null, 0.0));
        self::assertSame(2, Reconciler::notificationsRetryDelay(1, 0.5));
        self::assertSame(4, Reconciler::notificationsRetryDelay(2, 0.5));
        self::assertSame(60, Reconciler::notificationsRetryDelay(32, 0.5));
        self::assertSame(60, Reconciler::notificationsRetryDelay(60, 59.0));
        self::assertSame(1, Reconciler::notificationsRetryDelay(60, 60.0), 'a subscription that stayed up long enough resets the ramp');
    }

    public function testFailureMessagesAreRedactedBeforeTheyReachALog(): void
    {
        $line = Reconciler::sanitizeFailureMessage(new \RuntimeException('connect nostr+walletconnect://abc?relay=x&secret=deadbeef and lightning+swapconnect://ff.example/?key=k&secret=s failed'));
        self::assertSame('RuntimeException: connect [REDACTED_NWC] and [REDACTED_LSC] failed', $line);
    }

    public function testTheWorkerRunsThePeriodicPassResubscribesWithBackoffAndStops(): void
    {
        $subscriptions = 0;
        $idleTicks = 0;
        $client = new class ($subscriptions, $idleTicks) implements ReceiveNwcClient {
            public function __construct(private int &$subscriptions, private int &$idleTicks)
            {
            }

            public function makeInvoice(array $request): array
            {
                throw new \LogicException('not here');
            }

            public function listTransactions(array $request): array
            {
                return ['transactions' => []];
            }

            public function preflight(): array
            {
                return ['methods' => ['make_invoice', 'list_transactions'], 'encryption' => ['nip04']];
            }

            public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
            {
                $this->subscriptions++;
                if ($onIdle !== null) {
                    $onIdle();
                    $this->idleTicks++;
                }
                if ($this->subscriptions === 1) {
                    throw new \RuntimeException('relay closed');
                }
                // The second subscription ends cleanly (a relay that dropped without an error).
            }
        };
        $db = new PdoConnection(new \PDO('sqlite::memory:'));
        PaymentsSchema::migrate($db);
        $repository = new SqlPaymentRepository($db);
        $service = new Service($client, false, []);
        $passes = 0;
        $reconciler = new Reconciler($service, $repository, static function (): void {
        });
        $sleeps = [];
        $monotonic = 0.0;
        $worker = new Notifications($service, $reconciler, 15, null, static function (int $seconds) use (&$sleeps, &$monotonic): void {
            $sleeps[] = $seconds;
            $monotonic += $seconds;
        }, static function () use (&$monotonic): float {
            return $monotonic;
        });
        $rounds = 0;
        $worker->run(static function () use (&$rounds): bool {
            return ++$rounds <= 2;
        });
        self::assertSame(2, $subscriptions);
        self::assertSame(2, $idleTicks, 'the periodic pass runs on the idle tick of every subscription');
        self::assertSame([1, 1, 1], $sleeps, 'backoff remains cancellable in one-second steps');
        $worker->stop();
        $worker->run();
        self::assertSame(2, $subscriptions, 'a stopped worker does not resubscribe');
        self::assertSame(15, Notifications::intervalFromEnvironment([]));
        self::assertSame(3, Notifications::intervalFromEnvironment([Notifications::RECONCILE_INTERVAL_ENV => '3']));
    }
}
