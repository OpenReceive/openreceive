<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Storage;

use OpenReceive\Nwc\Errors;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Server\Reconciler;
use OpenReceive\Server\Notifications;
use OpenReceive\Server\Service;
use OpenReceive\Storage\SqlPaymentRepository;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\Attributes\DataProvider;
use Psr\Log\NullLogger;

final class PaymentSafetyTest extends DatabaseCase
{
    use VectorSupport;
    private int $now = 1000;
    private int $fulfilled = 0;
    private Service $service;

    private function reconciler(SqlPaymentRepository $repo, callable $list, ?callable $fulfill = null): Reconciler
    {
        $wallet = new class ($list) implements ReceiveNwcClient {
            public function __construct(private readonly mixed $list) {}
            public function preflight(): array { return ['methods' => ['make_invoice', 'list_transactions'], 'encryption' => ['nip04']]; }
            public function makeInvoice(array $request): array { throw new \LogicException('not minted'); }
            public function listTransactions(array $request): array { return ($this->list)($request); }
            public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void {}
        };
        $fulfill ??= function (): void { $this->fulfilled++; };
        $this->service = new Service($wallet, false, [], ['USD'], fn (): int => $this->now);
        return new Reconciler($this->service, $repo,
            static fn (array $event): bool => $repo->markPaidOnce($event['payment_hash'], $event['paid_at'], $event['details'], $fulfill),
            false, new NullLogger(), fn (): int => $this->now);
    }

    private function seed(SqlPaymentRepository $repo, string $hash, ?string $reference = null, string $source = 'wallet', int $expiry = 2800, ?array $swap = null): void
    {
        $reference ??= 'order-' . $hash;
        $repo->commitAttempt($reference, $hash, [...self::checkout($reference, $hash, 1000, $expiry), 'created_at_source' => $source], $swap);
    }

    private static function paid(string $hash): array
    {
        return ['type' => 'incoming', 'payment_hash' => $hash, 'created_at' => 1000, 'transaction_state' => 'settled', 'settled_at' => 1500];
    }

    public function testWorkerSettlesWhenHttpOpportunismIsDisabled(): void
    {
        $repo = new SqlPaymentRepository(self::freshDatabase('sqlite'), fn (): int => $this->now);
        $hash = self::hash('worker-only');
        $this->seed($repo, $hash);
        $calls = 0;
        $reconciler = $this->reconciler($repo, static function (array $request) use (&$calls, $hash): array {
            $calls++;
            return ['transactions' => ($request['offset'] ?? 0) === 0 ? [self::paid($hash)] : []];
        });
        self::assertSame(['reason' => 'disabled'], $reconciler->maybeReconcile());
        self::assertSame(0, $calls);
        $worker = new Notifications($this->service, $reconciler);
        $worker->run(static fn (): bool => false);
        self::assertSame(1, $this->fulfilled);
        self::assertSame('settled', $repo->listForReference('order-' . $hash)[0]->status);
        $before = $calls;
        $worker->run(static fn (): bool => false);
        self::assertSame($before, $calls);
        self::assertSame(1, $this->fulfilled);
    }

    #[DataProvider('dialects')]
    public function testSharedProgressVectorsUseTheDurableRepository(string $dialect): void
    {
        $family = self::vector('reconcile-progress');
        foreach ($family['vectors'] as $vector) {
            $this->now = 5000;
            $repo = new SqlPaymentRepository(self::freshDatabase($dialect), fn (): int => $this->now);
            if (isset($vector['lease_seconds'])) {
                $claim = $repo->claimReconcileGate(0, 2, $vector['lease_seconds']);
                $next = $repo->claimReconcileGate($vector['new_claim_at'], 2, $vector['lease_seconds']);
                self::assertNotNull($next);
                self::assertSame($vector['expected_old_checkpoint'], $repo->checkpointReconcileGate($claim, $claim['scheduler'], $vector['new_claim_at']));
                continue;
            }
            if (isset($vector['coverage_started_at'])) {
                $this->now = $vector['coverage_started_at'];
                $hash = self::hash('coverage');
                $this->seed($repo, $hash, expiry: $vector['expires_at']);
                $list = function () use ($vector): array {
                    $this->now = max($this->now, $vector['completed_at']);
                    return ['transactions' => []];
                };
                $engine = $this->reconciler($repo, $list);
                $engine->reconcile();
                self::assertSame('pending', $repo->findByPaymentHash($hash)->status);
                $this->now = $vector['next_scan_at'];
                $engine->reconcile();
                self::assertSame('expired', $repo->findByPaymentHash($hash)->status);
                continue;
            }
            $target = str_pad(dechex(($vector['paid_index'] ?? 0) + 1), 64, '0', STR_PAD_LEFT);
            for ($i = 0; $i < ($vector['pending_count'] ?? 1); $i++) {
                $hash = isset($vector['pending_count']) ? str_pad(dechex($i + 1), 64, '0', STR_PAD_LEFT) : $target;
                $created = 1000 + $i * ($vector['creation_stride'] ?? 0);
                $repo->commitAttempt('progress-' . $i, $hash, [...self::checkout('progress-' . $i, $hash, $created, isset($vector['paid_index']) ? 100000 : 2800), 'created_at_source' => 'wallet']);
            }
            $rows = [];
            for ($i = 0; $i < ($vector['history_rows'] ?? 1); $i++) $rows[] = self::paid(self::hash('history-' . $i));
            if (isset($vector['paid_index'])) $rows[isset($vector['history_rows']) ? $vector['paid_index'] : 0] = self::paid($target);
            $calls = 0;
            $list = static function (array $request) use ($rows, $vector, &$calls): array {
                $calls++;
                if (isset($vector['failed_cohorts']) && $request['from'] < 1000 + $vector['paid_index'] * $vector['creation_stride'] - 60) throw new \RuntimeException('historical cohort unavailable');
                return ['transactions' => array_slice($rows, $request['offset'], $vector['page_size'] ?? 20)];
            };
            $failures = $vector['failed_fulfillments'] ?? 0;
            $fulfill = function () use (&$failures): void {
                if ($failures > 0) { $failures--; throw new \RuntimeException('host rollback'); }
                $this->fulfilled++;
            };
            for ($pass = 0; $pass < ($vector['max_passes'] ?? 4); $pass++) {
                for ($arrival = 0; $arrival < ($vector['arrivals_per_pass'] ?? 0); $arrival++) {
                    $ref = "arrival-{$pass}-{$arrival}";
                    $hash = self::hash($ref);
                    $repo->commitAttempt($ref, $hash, self::checkout($ref, $hash, $this->now, $this->now + 600));
                }
                $before = $calls;
                $this->reconciler($repo, $list, $fulfill)->reconcile();
                self::assertLessThanOrEqual($family['max_pages'], $calls - $before, $vector['name']);
                $this->now += 12;
                // A fresh instance each pass proves progress is stored in the database.
                $repo = new SqlPaymentRepository($repo->connection(), fn (): int => $this->now);
            }
            if (isset($vector['paid_index'])) self::assertSame('settled', $repo->findByPaymentHash($target)->status, $vector['name']);
            else self::assertSame('pending', $repo->findByPaymentHash($target)->status, $vector['name']);
            $key = $dialect === 'mysql' ? '`key`' : 'key';
            $checkpoint = $repo->connection()->query("SELECT value FROM openreceive_meta WHERE {$key} = 'transaction_scan_gate'")[0]['value'];
            self::assertLessThanOrEqual($family['max_checkpoint_bytes'], strlen($checkpoint));
            self::assertStringNotContainsString('preimage', $checkpoint);
        }
    }

    #[DataProvider('dialects')]
    public function testSnapshotExpiryAndMalformedSnapshots(string $dialect): void
    {
        foreach (self::vector('attempt-reconciliation')['snapshot_cases'] as $case) {
            $this->now = $case['observed_at'];
            $repo = new SqlPaymentRepository(self::freshDatabase($dialect), fn (): int => $this->now);
            $hash = self::hash($case['name']);
            $this->seed($repo, $hash, expiry: $case['wallet_expires_at'], swap: self::swapData('USDT_TRON', $case['instruction_expires_at']));
            self::assertSame($case['instruction_expires_at'], $repo->findByPaymentHash($hash)->expiresAt);
            self::assertSame($case['wallet_expires_at'], $repo->findPendingAttempt($hash)['expires_at']);
            $this->reconciler($repo, static fn (): array => ['transactions' => []])->reconcile();
            self::assertSame($case['expected']['status'] ?? 'pending', $repo->findByPaymentHash($hash)->status, $case['name']);
            $repo->connection()->execute("UPDATE openreceive_payments SET status = 'pending', checkout_data = ? WHERE payment_hash = ?", ['{"provider_token":"test-private"}', $hash]);
            try {
                $repo->findPendingAttempt($hash);
                self::fail('missing wallet expiry silently accepted');
            } catch (\RuntimeException $e) {
                self::assertStringContainsString('checkout_data', $e->getMessage());
                self::assertStringNotContainsString('test-private', $e->getMessage());
            }
        }
    }

    #[DataProvider('dialects')]
    public function testPositiveEvidenceSurvivesLaterPageFailureAndHookRollback(string $dialect): void
    {
        $repo = new SqlPaymentRepository(self::freshDatabase($dialect), fn (): int => $this->now);
        $paid = self::hash('paid'); $pending = self::hash('pending');
        $this->seed($repo, $paid); $this->seed($repo, $pending);
        $page = static function (array $request) use ($paid): array {
            if ($request['offset'] > 0) throw new \RuntimeException('synthetic later page failure');
            return ['transactions' => [self::paid($paid)]];
        };
        $reconciler = $this->reconciler($repo, $page);
        self::assertCount(1, $reconciler->reconcile());
        self::assertSame('settled', $repo->findByPaymentHash($paid)->status);
        self::assertSame('pending', $repo->findByPaymentHash($pending)->status);
        self::assertSame(1, $this->fulfilled);
        $this->now += 12;
        $this->reconciler($repo, static fn (array $request): array => ['transactions' => $request['offset'] === 0 ? [self::paid($pending)] : []],
            static function (): void { throw new \RuntimeException('synthetic callback failure'); })->reconcile();
        self::assertSame('pending', $repo->findByPaymentHash($pending)->status);
    }

    #[DataProvider('dialects')]
    public function testFailedFulfillmentPastGraceCannotBecomeAbsenceAndDoesNotBlockSibling(string $dialect): void
    {
        $repo = new SqlPaymentRepository(self::freshDatabase($dialect), fn (): int => $this->now);
        $failed = self::hash('failed-delivery'); $paid = self::hash('other-paid'); $unpaid = self::hash('unpaid');
        foreach ([$failed, $paid, $unpaid] as $hash) $this->seed($repo, $hash);
        $this->now = 4000;
        $list = static fn (array $request): array => ['transactions' => $request['offset'] === 0 && !($request['unpaid'] ?? false) ? [self::paid($failed), self::paid($paid)] : []];
        $delivered = [];
        $fail = true;
        $fulfill = static function (\OpenReceive\PaymentSettlement $event) use ($failed, &$fail, &$delivered): void {
            if ($fail && $event->paymentHash === $failed) throw new \RuntimeException('synthetic fulfillment rollback');
            $delivered[] = $event->paymentHash;
        };
        $checks = $this->reconciler($repo, $list, $fulfill)->reconcile();
        self::assertSame('pending', $repo->findByPaymentHash($failed)->status);
        self::assertSame('settled', $repo->findByPaymentHash($paid)->status);
        self::assertSame('expired', $repo->findByPaymentHash($unpaid)->status);
        self::assertNotContains($failed, array_column($checks, 'payment_hash'));
        self::assertSame([$paid], $delivered);
        $fail = false; $this->now += 12;
        $this->reconciler($repo, $list, $fulfill)->reconcile();
        $this->now += 12;
        $this->reconciler($repo, $list, $fulfill)->reconcile();
        self::assertSame('settled', $repo->findByPaymentHash($failed)->status);
        self::assertSame([$paid, $failed], $delivered);
    }

    #[DataProvider('dialects')]
    public function testUnknownCreationProvenanceAndExpiredLeaseAreConservative(string $dialect): void
    {
        $repo = new SqlPaymentRepository(self::freshDatabase($dialect), fn (): int => $this->now);
        $hash = self::hash('clock-skew'); $this->seed($repo, $hash, source: 'host');
        $list = function (array $request) use ($hash): array {
            self::assertSame(0, $request['from']); self::assertArrayNotHasKey('until', $request);
            $this->now += 11;
            return ['transactions' => [self::paid($hash)]];
        };
        self::assertSame([], $this->reconciler($repo, $list)->reconcile());
        self::assertSame('pending', $repo->findByPaymentHash($hash)->status, 'a stale lease cannot commit or publish evidence');
        $this->now += 12;
        $this->reconciler($repo, static fn (): array => ['transactions' => [self::paid($hash)]])->reconcile();
        self::assertSame('settled', $repo->findByPaymentHash($hash)->status);
    }

    #[DataProvider('dialects')]
    public function testExplicitAttentionReviewAndEarlyClosureRepairPreserveHistory(string $dialect): void
    {
        $repo = new SqlPaymentRepository(self::freshDatabase($dialect), fn (): int => $this->now);
        $hash = self::hash('attention'); $this->seed($repo, $hash);
        $this->now = 3700;
        $reconciler = $this->reconciler($repo, static fn (array $request): array => ['transactions' => $request['offset'] === 0 ? [['payment_hash' => $hash, 'state' => 'accepted']] : []]);
        $reconciler->reconcile();
        self::assertSame('attention', $repo->findByPaymentHash($hash)->status);
        $finality = $this->reconciler($repo, static fn (): array => ['transactions' => [self::paid($hash)]]);
        self::assertFalse($finality->settleFromNotification(['notification' => self::paid($hash)]));
        self::assertSame([], $finality->reconcile());
        $report = $repo->maintenanceCandidates(limit: 1);
        self::assertSame(1, $report['scanned']);
        $candidate = $report['candidates'][0];
        self::assertSame('operator_attention', $candidate['reason']);
        self::assertTrue($repo->requeueReviewedAttempt($candidate, 'ticket-1'));
        self::assertFalse($repo->requeueReviewedAttempt($candidate, 'ticket-1'));
        self::assertSame(0, $this->fulfilled, 'requeue grants nothing');
        $this->now += 12;
        $finality->reconcile();
        self::assertSame('settled', $repo->findByPaymentHash($hash)->status);
        self::assertSame(1, $this->fulfilled);
        self::assertFalse($repo->requeueReviewedAttempt($candidate, 'ticket-2'));
        $early = self::hash('early');
        $this->seed($repo, $early, swap: self::swapData('USDT_TRON', 1600));
        $repo->recordReconciliation($early, 'expired', 2500, 'not_found_after_expiry');
        $candidate = $repo->maintenanceCandidates()['candidates'][0];
        self::assertSame('early_deposit_deadline_closure', $candidate['reason']);
        self::assertTrue($repo->requeueReviewedAttempt($candidate, 'early-review'));
        $repo->recordReconciliation($early, 'attention', $this->now, 'unsettled_after_expiry');
        $new = $repo->maintenanceCandidates()['candidates'][0];
        self::assertFalse($repo->requeueReviewedAttempt($new, 'early-review'), 'same decision never replays after a second attention');
        $key = $dialect === 'mysql' ? '`key`' : 'key';
        $audit = $repo->connection()->query("SELECT value FROM openreceive_meta WHERE {$key} LIKE 'repair:%'");
        self::assertCount(2, $audit);
        self::assertStringNotContainsString('provider_token', json_encode($audit));
    }

    public function testSecretRedactionMatchesTheSharedFixture(): void
    {
        foreach (self::vector('secret-redaction')['vectors'] as $vector) {
            self::assertSameRecord($vector['expected'], Errors::sanitizeValue($vector['input']), $vector['name']);
        }
    }
}
