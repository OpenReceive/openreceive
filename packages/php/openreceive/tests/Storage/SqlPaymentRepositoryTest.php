<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Storage;

use OpenReceive\PaymentSettlement;
use OpenReceive\Server\Errors\ConflictError;
use OpenReceive\Storage\SqlPaymentRepository;
use PHPUnit\Framework\Attributes\DataProvider;

final class SqlPaymentRepositoryTest extends DatabaseCase
{
    private int $now = 1_100;

    private function repository(string $dialect): SqlPaymentRepository
    {
        return new SqlPaymentRepository(self::freshDatabase($dialect), fn (): int => $this->now);
    }

    #[DataProvider('dialects')]
    public function testCommitIsIdempotentForARepeatedHashAndRefusesAPaidReference(string $dialect): void
    {
        $repo = $this->repository($dialect);
        $hash = self::hash('a');
        $first = $repo->commitAttempt('order-1', $hash, self::checkout('order-1', $hash), null, '203.0.113.9');
        $again = $repo->commitAttempt('order-1', $hash, self::checkout('order-1', $hash));
        self::assertSame($first->paymentHash, $again->paymentHash);
        self::assertSame('pending', $again->status);
        self::assertSame(1_600, $again->expiresAt);
        self::assertSame(1_000, $again->createdAt);
        self::assertSame($this->now, $again->insertedAt);
        self::assertSame('203.0.113.9', $again->clientIp);
        self::assertCount(1, $repo->listForReference('order-1'));

        self::assertTrue($repo->markPaidOnce($hash, 1_200, null, static fn (PaymentSettlement $s) => null));
        try {
            $repo->commitAttempt('order-1', self::hash('b'), self::checkout('order-1', self::hash('b')));
            self::fail('a paid reference accepted a new attempt');
        } catch (ConflictError $e) {
            self::assertSame('This reference is already paid.', $e->getMessage());
        }
        try {
            $repo->commitAttempt('order-2', $hash, self::checkout('order-2', $hash));
            self::fail('a hash moved between references');
        } catch (ConflictError $e) {
            self::assertSame('payment hash belongs to another reference', $e->getMessage());
        }
    }

    #[DataProvider('dialects')]
    public function testOneLiveAttemptPerRailWithSupersedeNearExpiry(string $dialect): void
    {
        $repo = $this->repository($dialect);
        $lightning = self::hash('ln1');
        $repo->commitAttempt('order-2', $lightning, self::checkout('order-2', $lightning));
        // Same rail, still reusable: conflict with the one agreed payer-facing string.
        try {
            $repo->commitAttempt('order-2', self::hash('ln2'), self::checkout('order-2', self::hash('ln2')));
            self::fail('a second live Lightning attempt was accepted');
        } catch (ConflictError $e) {
            self::assertSame('An unpaid checkout for this payment method is already in progress for this reference.', $e->getMessage());
        }
        // A different rail (a Tron swap) is independent, and so is a second swap asset.
        $tron = self::hash('tron');
        $repo->commitAttempt('order-2', $tron, self::checkout('order-2', $tron), self::swapData('USDT_TRON'));
        $sol = self::hash('sol');
        $repo->commitAttempt('order-2', $sol, self::checkout('order-2', $sol), self::swapData('SOL_SOL'));
        self::assertSame(1_900, $repo->listForReference('order-2')[0]->expiresAt, 'a swap attempt expires with the provider order');
        // Inside the 60s reuse buffer the live row is superseded, not conflicted, and stays pending.
        $this->now = 1_550;
        $late = self::hash('ln3');
        $repo->commitAttempt('order-2', $late, self::checkout('order-2', $late, 1_550, 1_605));
        $byHash = [];
        foreach ($repo->listForReference('order-2') as $row) {
            $byHash[$row->paymentHash] = $row;
        }
        self::assertSame('superseded', $byHash[$lightning]->statusReason);
        self::assertSame('pending', $byHash[$lightning]->status);
        self::assertNull($byHash[$late]->statusReason);
        // A still-reusable live attempt on the rail conflicts; the superseded one
        // (still unexpired) neither blocks nor is superseded again.
        $this->now = 1_560;
        $fourth = self::hash('ln4');
        $repo->commitAttempt('order-2', $fourth, self::checkout('order-2', $fourth, 1_560, 2_160));
        $byHash = [];
        foreach ($repo->listForReference('order-2') as $row) {
            $byHash[$row->paymentHash] = $row;
        }
        self::assertCount(5, $byHash);
        self::assertSame('superseded', $byHash[$late]->statusReason, 'inside the reuse buffer the live row is superseded');
        self::assertSame('superseded', $byHash[$lightning]->statusReason);
        self::assertNull($byHash[$fourth]->statusReason);
        $this->expectException(ConflictError::class);
        $repo->commitAttempt('order-2', self::hash('ln5'), self::checkout('order-2', self::hash('ln5'), 1_560, 2_160));
    }

    #[DataProvider('dialects')]
    public function testSelectedForResolvesTheAttemptEachRouteIsAbout(string $dialect): void
    {
        $repo = $this->repository($dialect);
        self::assertNull($repo->selectedFor('order-3', 'checkout.create'));
        $ln = self::hash('s-ln');
        $repo->commitAttempt('order-3', $ln, self::checkout('order-3', $ln));
        self::assertSame($ln, $repo->selectedFor('order-3', 'checkout.create')?->paymentHash, 'a reusable live attempt is re-served');
        self::assertNull($repo->selectedFor('order-3', 'swap.create', null, 'USDT_TRON'), 'the swap rail is empty');
        self::assertNull($repo->selectedFor('order-3', 'swap.read'), 'no swap attempt exists');
        self::assertSame($ln, $repo->selectedFor('order-3', 'payment.check', $ln)?->paymentHash);
        self::assertNull($repo->selectedFor('order-3', 'payment.check', self::hash('missing')));
        $swap = self::hash('s-swap');
        $repo->commitAttempt('order-3', $swap, self::checkout('order-3', $swap, 1_001), self::swapData('USDT_TRON'));
        self::assertSame($swap, $repo->selectedFor('order-3', 'swap.read')?->paymentHash);
        self::assertSame($swap, $repo->selectedFor('order-3', 'swap.create', null, 'USDT_TRON')?->paymentHash);
        self::assertNull($repo->selectedFor('order-3', 'swap.create', null, 'SOL_SOL'));
        // Within the reuse buffer the live row is not re-served: the create mints a new one.
        $this->now = 1_560;
        self::assertNull($repo->selectedFor('order-3', 'checkout.create'));
        $repo->markPaidOnce($ln, 1_570, null, static fn () => null);
        $this->expectException(ConflictError::class);
        $repo->selectedFor('order-3', 'checkout.create');
    }

    #[DataProvider('dialects')]
    public function testSettlementIsWriteOnceAndFulfillsOnlyTheFirstSettledAttempt(string $dialect): void
    {
        $repo = $this->repository($dialect);
        $first = self::hash('p1');
        $second = self::hash('p2');
        $repo->commitAttempt('order-4', $first, self::checkout('order-4', $first));
        $repo->commitAttempt('order-4', $second, self::checkout('order-4', $second), self::swapData('USDT_TRON'));
        $fulfilled = [];
        $fulfill = static function (PaymentSettlement $settlement) use (&$fulfilled): void {
            $fulfilled[] = $settlement->paymentHash;
            self::assertSame('order-4', $settlement->reference);
            self::assertNotNull($settlement->connection);
            self::assertSame('x', $settlement->details['note'] ?? null);
        };
        self::assertTrue($repo->markPaidOnce($first, 1_200, ['note' => 'x'], $fulfill));
        // Replayed delivery of the same settlement: recorded already, never fulfilled again.
        self::assertFalse($repo->markPaidOnce($first, 1_200, ['note' => 'x'], $fulfill));
        // An accidental second payment on a sibling attempt is recorded, not fulfilled.
        self::assertFalse($repo->markPaidOnce($second, 1_300, ['note' => 'x'], $fulfill));
        self::assertSame([$first], $fulfilled);
        $rows = [];
        foreach ($repo->listForReference('order-4') as $row) {
            $rows[$row->paymentHash] = $row;
        }
        self::assertSame('settled', $rows[$first]->status);
        self::assertNull($rows[$first]->statusReason);
        self::assertSame(1_200, $rows[$first]->paidAt);
        self::assertSame('settled', $rows[$second]->status);
        self::assertSame('duplicate_settlement', $rows[$second]->statusReason);
        self::assertFalse($repo->markPaidOnce(self::hash('unknown'), 1_400, null, $fulfill));
        // A settled row is never overwritten by a late reconciliation transition.
        $repo->recordReconciliation($first, 'expired', 5_000, 'not_found_after_expiry');
        self::assertSame('settled', $repo->listForReference('order-4')[1]->status);
    }

    #[DataProvider('dialects')]
    public function testAThrowingOnPaidRollsTheSettlementBack(string $dialect): void
    {
        $repo = $this->repository($dialect);
        $hash = self::hash('rb');
        $repo->commitAttempt('order-5', $hash, self::checkout('order-5', $hash));
        try {
            $repo->markPaidOnce($hash, 1_200, null, static function (): void {
                throw new \RuntimeException('fulfillment exploded');
            });
            self::fail('the fulfillment failure was swallowed');
        } catch (\RuntimeException $e) {
            self::assertSame('fulfillment exploded', $e->getMessage());
        }
        self::assertSame('pending', $repo->listForReference('order-5')[0]->status, 'the row stays pending for the next pass');
        // The host's own statements run in the settlement transaction and commit with it.
        $db = $repo->connection();
        $db->execute('CREATE TABLE IF NOT EXISTS host_orders (id VARCHAR(64) PRIMARY KEY, state VARCHAR(32) NOT NULL)');
        $db->execute('DELETE FROM host_orders');
        $db->execute("INSERT INTO host_orders (id, state) VALUES ('order-5', 'awaiting_payment')");
        self::assertTrue($repo->markPaidOnce($hash, 1_200, null, static function (PaymentSettlement $s): void {
            self::assertSame(1, $s->connection?->execute("UPDATE host_orders SET state = 'paid' WHERE id = ? AND state = 'awaiting_payment'", [$s->reference]));
        }));
        self::assertSame('paid', $db->query('SELECT state FROM host_orders WHERE id = ?', ['order-5'])[0]['state']);
    }

    #[DataProvider('dialects')]
    public function testReconciliationTransitionsAndBatches(string $dialect): void
    {
        $repo = $this->repository($dialect);
        $old = self::hash('old');
        $new = self::hash('new');
        $repo->commitAttempt('order-6', $new, self::checkout('order-6', $new, 2_000, 2_600));
        $repo->commitAttempt('order-7', $old, self::checkout('order-7', $old, 900, 1_500));
        self::assertSame([$old, $new], array_column($repo->reconcilableAttempts(), 'payment_hash'), 'oldest first');
        self::assertSame(['payment_hash' => $old, 'created_at' => 900, 'expires_at' => 1_500], $repo->findPendingAttempt($old));
        $repo->recordReconciliation($old, 'expired', 2_500, 'not_found_after_expiry');
        self::assertSame([$new], array_column($repo->reconcilableAttempts(), 'payment_hash'), 'terminal rows leave the scan set');
        self::assertNull($repo->findPendingAttempt($old));
        self::assertSame('not_found_after_expiry', $repo->listForReference('order-7')[0]->statusReason);
        $repo->recordReconciliation($new, 'attention', 4_000, 'unsettled_after_expiry');
        self::assertSame('attention', $repo->listForReference('order-6')[0]->status);
        $this->expectException(\InvalidArgumentException::class);
        $repo->recordReconciliation($new, 'settled', 4_000, 'nope');
    }

    #[DataProvider('dialects')]
    public function testTheReconcileGateIsADurableCasSharedByEveryWorker(string $dialect): void
    {
        $repo = $this->repository($dialect);
        $other = new SqlPaymentRepository($repo->connection(), fn (): int => $this->now);
        self::assertTrue($repo->claimReconcileGate(1_000, 2));
        self::assertFalse($other->claimReconcileGate(1_001, 2), 'another worker within the interval is gate_busy');
        self::assertTrue($other->claimReconcileGate(1_002, 2), 'the interval elapsed');
        self::assertFalse($repo->claimReconcileGate(1_003, 2));
        // A stamp far in the future is a clock that stepped backwards, not a fresh claim.
        $repo->connection()->execute('UPDATE openreceive_meta SET value = ? WHERE ' . ($dialect === 'mysql' ? '`key`' : 'key') . ' = ?', [json_encode(['claimed_at' => 9_000, 'token' => 'x']), 'transaction_scan_gate']);
        self::assertTrue($repo->claimReconcileGate(1_004, 2));
    }

    #[DataProvider('dialects')]
    public function testTheRateLimitBudgetCountsOnInsertedAt(string $dialect): void
    {
        $repo = $this->repository($dialect);
        $this->now = 5_000;
        $repo->commitAttempt('order-8', self::hash('ip1'), self::checkout('order-8', self::hash('ip1'), 900, 6_000), null, '198.51.100.7');
        $this->now = 9_000;
        $repo->commitAttempt('order-9', self::hash('ip2'), self::checkout('order-9', self::hash('ip2'), 900, 10_000), null, '198.51.100.7');
        $repo->commitAttempt('order-10', self::hash('ip3'), self::checkout('order-10', self::hash('ip3'), 900, 10_000), null, '198.51.100.8');
        self::assertSame(2, $repo->countAttemptsFromIp('198.51.100.7', 5_000));
        self::assertSame(1, $repo->countAttemptsFromIp('198.51.100.7', 5_001));
        // A later status transition moves updated_at only; the budget window does not re-enter the old row.
        $repo->recordReconciliation(self::hash('ip1'), 'expired', 9_500, 'not_found_after_expiry');
        self::assertSame(1, $repo->countAttemptsFromIp('198.51.100.7', 5_001));
        self::assertSame(0, $repo->countAttemptsFromIp('203.0.113.1', 0));
    }
}
