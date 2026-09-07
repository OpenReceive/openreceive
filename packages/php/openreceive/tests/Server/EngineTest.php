<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use Nyholm\Psr7\Factory\Psr17Factory;
use OpenReceive\Host;
use OpenReceive\Hosts\AfterPaid;
use OpenReceive\Hosts\AllowAllAuthorize;
use OpenReceive\Hosts\LoggingOnPaid;
use OpenReceive\PaymentSettlement;
use OpenReceive\Rates\StaticPriceProvider;
use OpenReceive\Server\AuthorizeContext;
use OpenReceive\Server\Doctor;
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
 * The whole engine over sqlite: Host + repository + Service through the PSR-15
 * mount, with the fakes. Covers the host-glue invariants AGENTS.md names:
 * commit before instructions, the gated request-path reconcile, payments/check
 * served from the pass or the row, replay-safe onPaid once per reference,
 * notification direct settlement, swap attempts with server-only swap_data.
 */
final class EngineTest extends TestCase
{
    private int $now = 1_700_000_000;
    private FakeWallet $wallet;
    private FakeSwapProvider $provider;
    private SqlPaymentRepository $repository;
    /** @var list<string> */
    private array $paid = [];
    /** @var list<string> */
    private array $afterPaid = [];
    /** @var list<string> */
    private array $logs = [];

    private function host(bool $placeholders = false): Host
    {
        if ($placeholders) {
            return new class implements Host {
                use AllowAllAuthorize;
                use LoggingOnPaid;

                public function amountFor(string $reference): ?array
                {
                    return ['sats' => 2100];
                }

                protected function openReceiveLog(string $line): void
                {
                }
            };
        }
        $test = $this;
        return new class ($test) implements Host, AfterPaid {
            public function __construct(private readonly EngineTest $test)
            {
            }

            public function authorize(AuthorizeContext $context): bool
            {
                return $context->reference() !== 'forbidden-order';
            }

            public function amountFor(string $reference): ?array
            {
                return match (true) {
                    str_starts_with($reference, 'usd-') => ['currency' => 'USD', 'value' => '1.00', 'description' => 'One dollar'],
                    str_starts_with($reference, 'order-') => ['sats' => 2100],
                    default => null,
                };
            }

            public function onPaid(PaymentSettlement $settlement): void
            {
                $this->test->recordPaid($settlement);
            }

            public function afterPaid(PaymentSettlement $settlement): void
            {
                $this->test->recordAfterPaid($settlement);
            }
        };
    }

    public function recordPaid(PaymentSettlement $settlement): void
    {
        self::assertNotNull($settlement->connection, 'onPaid runs inside the settlement transaction');
        $this->paid[] = $settlement->reference;
    }

    public function recordAfterPaid(PaymentSettlement $settlement): void
    {
        self::assertNull($settlement->connection, 'afterPaid runs after COMMIT');
        $this->afterPaid[] = $settlement->reference;
    }

    private function engine(bool $placeholders = false, bool|array $opportunistic = true, bool|array $rateLimiting = false): Engine
    {
        $clock = fn (): int => $this->now;
        $this->wallet = new FakeWallet($clock);
        $this->provider = new FakeSwapProvider('fixedfloat', $clock);
        $db = new PdoConnection(new \PDO('sqlite::memory:'));
        PaymentsSchema::migrate($db);
        $this->repository = new SqlPaymentRepository($db, $clock);
        $service = new Service($this->wallet, new StaticPriceProvider(), [$this->provider], ['USD'], $clock);
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
        return new Engine($this->host($placeholders), $this->repository, $service, $opportunistic, $rateLimiting, null, null, $logger, '/openreceive', new Psr17Factory());
    }

    /** @param array<string, mixed>|null $body */
    private function call(Engine $engine, string $method, string $path, ?array $body = null, string $ip = '203.0.113.5'): ResponseInterface
    {
        $factory = new Psr17Factory();
        $request = $factory->createServerRequest($method, "http://shop.test{$path}", ['REMOTE_ADDR' => $ip])->withHeader('content-type', 'application/json');
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

    public function testACheckoutIsCommittedBeforeInstructionsThenSettledExactlyOnce(): void
    {
        $engine = $this->engine();
        $prepared = self::json($this->call($engine, 'POST', '/openreceive/checkouts/prepare', ['reference' => 'usd-1']));
        self::assertSame(2_000_000, $prepared['amount_msats'], 'a $1.00 button is 2,000 sats at the static price');
        self::assertSame('One dollar', $prepared['description']);
        self::assertSame('50000.00', $prepared['fiat_quote']['btc_fiat_price']);
        self::assertCount(7, $prepared['payment_methods']);

        $created = self::json($this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'order-1', 'memo' => 'hat']));
        $checkout = $created['checkout'];
        self::assertSame(str_repeat('0', 63) . '1', $checkout['payment_hash']);
        self::assertSame(2_100_000, $checkout['amount_msats']);
        $row = $this->repository->findByPaymentHash($checkout['payment_hash']);
        self::assertSame('pending', $row?->status);
        self::assertSame('203.0.113.5', $row?->clientIp);

        // A repeated create re-serves the committed attempt without minting again.
        $again = self::json($this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'order-1']));
        self::assertSame($checkout['payment_hash'], $again['checkout']['payment_hash']);
        self::assertCount(1, $this->wallet->listInvoices());

        // Pending: past the gate interval the pass runs, finds the unpaid row, and the check serves it from the pass.
        $this->now += 3;
        $pending = self::json($this->call($engine, 'POST', '/openreceive/payments/check', ['reference' => 'order-1', 'payment_hash' => $checkout['payment_hash']]));
        self::assertSame('pending', $pending['status']);
        self::assertSame('pending', $pending['details']['transaction']['transaction_state']);
        self::assertArrayNotHasKey('preimage', $pending['details']['transaction']);

        // Within the gate interval another request is gate_busy and is answered from the row.
        $busy = self::json($this->call($engine, 'POST', '/openreceive/payments/check', ['reference' => 'order-1', 'payment_hash' => $checkout['payment_hash']]));
        self::assertSame(['payment_hash' => $checkout['payment_hash'], 'status' => 'pending', 'payment_methods' => $busy['payment_methods']], $busy);

        $this->wallet->settleInvoice($checkout['payment_hash'], $this->now + 5);
        $this->now += 3;
        $settled = self::json($this->call($engine, 'POST', '/openreceive/payments/check', ['reference' => 'order-1', 'payment_hash' => $checkout['payment_hash']]));
        self::assertSame('settled', $settled['status']);
        self::assertSame($this->now + 2, $settled['paid_at']);
        self::assertSame('settled_at', $settled['details']['paid_at_source']);
        self::assertSame(['order-1'], $this->paid);
        self::assertSame(['order-1'], $this->afterPaid);
        self::assertSame('settled', $this->repository->findByPaymentHash($checkout['payment_hash'])?->status);

        // A replayed pass and a fresh create against the paid reference never fulfill again.
        $this->now += 3;
        $engine->reconcile();
        self::assertSame(['order-1'], $this->paid);
        $refused = $this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'order-1']);
        self::assertSame(409, $refused->getStatusCode());
        self::assertSame('This reference is already paid.', self::json($refused)['message']);
    }

    public function testUnknownForbiddenAndMalformedReferencesAnswerWithTheContract(): void
    {
        $engine = $this->engine();
        $unknown = $this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'nope-1']);
        self::assertSame(404, $unknown->getStatusCode());
        self::assertSame('Unknown reference.', self::json($unknown)['message']);
        $forbidden = $this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'forbidden-order']);
        self::assertSame(403, $forbidden->getStatusCode());
        self::assertSame('FORBIDDEN', self::json($forbidden)['code']);
        $missing = $this->call($engine, 'POST', '/openreceive/payments/check', ['reference' => 'order-9', 'payment_hash' => str_repeat('9', 64)]);
        self::assertSame(404, $missing->getStatusCode());
        self::assertSame('Payment attempt not found for this reference.', self::json($missing)['message']);
        $rates = self::json($this->call($engine, 'GET', '/openreceive/rates?currencies=USD'));
        self::assertSame(['bitcoin' => ['usd' => '50000.00']], $rates);
    }

    public function testASwapAttemptKeepsSwapDataServerSideAndRefundsOnlyFromRefundRequired(): void
    {
        $engine = $this->engine();
        $quote = self::json($this->call($engine, 'POST', '/openreceive/swaps/quote', ['reference' => 'order-2', 'pay_in_asset' => 'USDT_TRON']));
        self::assertSame('1.05', $quote['pay_amount']);
        $created = $this->call($engine, 'POST', '/openreceive/swaps', ['reference' => 'order-2', 'pay_in_asset' => 'USDT_TRON']);
        self::assertSame(201, $created->getStatusCode());
        $swap = self::json($created)['swap'];
        self::assertSame('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', $swap['deposit_address']);
        self::assertSame('awaiting_deposit', $swap['provider_state']);
        self::assertArrayNotHasKey('swap_data', $swap);
        self::assertArrayNotHasKey('provider_token', $swap);
        self::assertStringNotContainsString('testkit-token', (string) $created->getBody());
        $hash = $swap['checkout']['payment_hash'];
        // The shadow invoice honours the provider's 1800 s floor and the row expires with the provider order.
        self::assertSame(1_800, $swap['checkout']['expires_at'] - $swap['checkout']['created_at']);
        $row = $this->repository->findByPaymentHash($hash);
        self::assertSame($this->now + 900, $row?->expiresAt);
        self::assertSame('testkit-token-1', $row?->swapData['provider_order']['provider_token']);
        self::assertArrayNotHasKey('swap_data', $row?->toArray() ?? []);

        // A second swap create on the same asset re-serves the live attempt (status refreshed from the provider).
        $reused = self::json($this->call($engine, 'POST', '/openreceive/swaps', ['reference' => 'order-2', 'pay_in_asset' => 'USDT_TRON']))['swap'];
        self::assertSame($hash, $reused['payment_hash']);
        self::assertSame(1, $this->provider->counters()['create_calls']);

        $tooEarly = $this->call($engine, 'POST', '/openreceive/swaps/refunds', ['reference' => 'order-2', 'payment_hash' => $hash, 'refund_address' => 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf']);
        self::assertSame(409, $tooEarly->getStatusCode());
        $this->provider->forceRefundRequired('USDT_TRON');
        $badChecksum = $this->call($engine, 'POST', '/openreceive/swaps/refunds', ['reference' => 'order-2', 'payment_hash' => $hash, 'refund_address' => 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBg']);
        self::assertSame(400, $badChecksum->getStatusCode());
        self::assertSame('refundAddress is not a valid USDT_TRON address.', self::json($badChecksum)['message']);
        $refunded = self::json($this->call($engine, 'POST', '/openreceive/swaps/refunds', ['reference' => 'order-2', 'payment_hash' => $hash, 'refund_address' => 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf']));
        self::assertSame('refund_pending', $refunded['provider_state']);
        $status = self::json($this->call($engine, 'POST', '/openreceive/swaps/status', ['reference' => 'order-2', 'payment_hash' => $hash]));
        self::assertSame('refund_pending', $status['provider_state']);
        self::assertSame('TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', $this->provider->counters()['refund_calls'][0]['refund_address']);
    }

    public function testANotificationWithFinalitySettlesDirectlyAndOneWithoutFallsBackToAScan(): void
    {
        $engine = $this->engine(false, false);
        $created = self::json($this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'order-3']));
        $hash = $created['checkout']['payment_hash'];
        $reconciler = $engine->reconciler();
        self::assertSame(['reason' => 'disabled'], $reconciler->maybeReconcile());
        // No finality signal: only a bounded scan may act, and the scan finds it unpaid.
        $reconciler->handleNotification(['notification_type' => 'payment_received', 'notification' => ['payment_hash' => $hash, 'preimage' => FakeWallet::PREIMAGE]]);
        self::assertSame([], $this->paid);
        // Other notification types are ignored outright.
        $reconciler->handleNotification(['notification_type' => 'payment_sent', 'notification' => ['payment_hash' => $hash, 'settled_at' => $this->now]]);
        self::assertSame([], $this->paid);
        // The wallet's own payment_received with settled_at settles without a wallet scan.
        $this->wallet->subscribeNotifications(static fn (array $n) => $reconciler->handleNotification($n));
        $this->wallet->settleInvoice($hash, $this->now + 1, null, true);
        self::assertSame(['order-3'], $this->paid);
        self::assertSame('settled', $this->repository->findByPaymentHash($hash)?->status);
        self::assertSame($this->now + 1, $this->repository->findByPaymentHash($hash)?->paidAt);
        // Replayed notification: unknown-pending hash → one scan, nothing fulfilled twice.
        $this->wallet->settleInvoice($hash, $this->now + 1, null, true);
        self::assertSame(['order-3'], $this->paid);
    }

    public function testReconcileClosesAbandonedAttemptsOnlyAfterExpiryPlusGrace(): void
    {
        $engine = $this->engine(false, false);
        $created = self::json($this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'order-4']));
        $hash = $created['checkout']['payment_hash'];
        $expiresAt = $created['checkout']['expires_at'];
        $this->now = $expiresAt + 899;
        $engine->reconcile();
        self::assertSame('pending', $this->repository->findByPaymentHash($hash)?->status, 'inside the grace window nothing closes');
        $this->now = $expiresAt + 900;
        $engine->reconcile();
        $row = $this->repository->findByPaymentHash($hash);
        // The fake lists the unpaid invoice with an explicit pending state: the wallet still claims it is in flight.
        self::assertSame('attention', $row?->status);
        self::assertSame('unsettled_after_expiry', $row?->statusReason);
        self::assertSame([], $engine->reconcile(), 'terminal rows leave the scan set');
        // Row `attention` serves as `pending` on the wire.
        $check = self::json($this->call($engine, 'POST', '/openreceive/payments/check', ['reference' => 'order-4', 'payment_hash' => $hash]));
        self::assertSame('pending', $check['status']);
        // A wallet-reported expiry closes immediately.
        $second = self::json($this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'order-5']));
        $this->wallet->expireInvoice($second['checkout']['payment_hash']);
        $engine->reconcile();
        self::assertSame('expired', $this->repository->findByPaymentHash($second['checkout']['payment_hash'])?->status);
        self::assertSame('wallet_reported_expired', $this->repository->findByPaymentHash($second['checkout']['payment_hash'])?->statusReason);
    }

    public function testTheGateIntervalStretchesWithInvoiceAge(): void
    {
        $engine = $this->engine();
        $reconciler = $engine->reconciler();
        $attempt = static fn (int $createdAt): array => ['payment_hash' => str_repeat('a', 64), 'created_at' => $createdAt, 'expires_at' => $createdAt + 600];
        self::assertSame(2, $reconciler->gateIntervalSeconds([$attempt(1000)], 1010));
        self::assertSame(6, $reconciler->gateIntervalSeconds([$attempt(1000)], 1200));
        self::assertSame(12, $reconciler->gateIntervalSeconds([$attempt(1000)], 1400));
        self::assertSame(2, $reconciler->gateIntervalSeconds([$attempt(1000), $attempt(1399)], 1400), 'the youngest pending invoice wins');
        self::assertSame(2, $reconciler->gateIntervalSeconds([$attempt(5000)], 1000), 'a wallet clock ahead of the host reads as freshly minted');
        self::assertSame(2, $reconciler->gateIntervalSeconds([], 1000));
    }

    public function testTheBuiltInRateLimiterMetersMintingOnly(): void
    {
        $engine = $this->engine(false, true, ['limit_per_hour' => 2]);
        self::assertSame(201, $this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'order-6'])->getStatusCode());
        self::assertSame(201, $this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'order-7'])->getStatusCode());
        $capped = $this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'order-8']);
        self::assertSame(429, $capped->getStatusCode());
        self::assertSame('60', $capped->getHeaderLine('retry-after'));
        self::assertSame('Too many payment attempts. Please try again later.', self::json($capped)['message']);
        // Re-serving an already committed attempt costs no mint and is not metered; another IP has its own budget.
        self::assertSame(201, $this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'order-6'])->getStatusCode());
        self::assertSame(201, $this->call($engine, 'POST', '/openreceive/checkouts', ['reference' => 'order-8'], '198.51.100.1')->getStatusCode());
        self::assertSame(200, $this->call($engine, 'POST', '/openreceive/checkouts/prepare', ['reference' => 'order-9'])->getStatusCode());
    }

    public function testPlaceholderHooksWarnAtBootAndInTheDoctor(): void
    {
        $engine = $this->engine(true);
        $warnings = array_values(array_filter($this->logs, static fn (string $line): bool => str_starts_with($line, 'warning:')));
        self::assertCount(2, $warnings);
        self::assertStringContainsString('allow-all', $warnings[0]);
        self::assertStringContainsString('logging-only', $warnings[1]);
        $lines = $engine->doctor(['NWC_URI' => 'x', 'LSC_URI_PRIMARY' => ''], static fn () => null, '/openreceive');
        $report = implode("\n", $lines);
        self::assertStringContainsString('NWC_URI:          set', $report);
        self::assertStringContainsString('LSC_URI_PRIMARY:  unset', $report);
        self::assertStringContainsString('the generated placeholder (allow-all)', $report);
        self::assertStringContainsString('the generated placeholder (logging-only)', $report);
        self::assertStringContainsString('wallet preflight: ok', $report);
        self::assertStringNotContainsString('x', explode("\n", $report)[1]);
        $failed = Doctor::report([], null, static function (): void {
            throw new \RuntimeException('relay refused nostr+walletconnect://abc?relay=x&secret=deadbeef');
        });
        self::assertStringContainsString('FAILED — RuntimeException: relay refused [REDACTED_NWC]', implode("\n", $failed));
        self::assertStringNotContainsString('deadbeef', implode("\n", $failed));
    }

    public function testCustomAndBuiltInRateLimitsAreMutuallyExclusive(): void
    {
        $this->expectException(\OpenReceive\ConfigurationError::class);
        $this->engine();
        new Engine($this->host(), $this->repository, new Service($this->wallet, false, []), true, true, static fn (): bool => true);
    }
}
