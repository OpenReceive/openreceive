<?php

declare(strict_types=1);

namespace OpenReceive\Server;

use OpenReceive\Nwc\Requests;
use OpenReceive\Payments\Reconciliation;
use OpenReceive\Settlement\Settlement;
use OpenReceive\Storage\PaymentRepository;
use OpenReceive\Support\Records;
use Psr\Log\LoggerInterface;

/**
 * The reconcile pass over the engine-owned ledger and the durable gate in
 * front of it (the Rails reconcile.rb twin). Attempt closure only ever happens
 * from a successful wallet scan observed at or after expiry plus the grace
 * constant — a local clock alone never closes a row. A wallet failure raises
 * and leaves every row pending; a hash absent from a truncated pass is no
 * information and stays untouched.
 */
final class Reconciler
{
    /** Floor for the durable gate interval, stretched by invoice age (2 s under 2 min old, 6 s under 5 min, else 12 s). */
    public const MIN_RECONCILE_INTERVAL_SECONDS = 2;
    /** Wall-clock bound on an awaited request-path pass, enforced as a deadline checked between page fetches. */
    public const RECONCILE_SCAN_TIMEOUT_SECONDS = 9;
    public const RECONCILE_SCAN_MAX_PAGES = 50;
    /** Cap on the notifications worker's resubscribe backoff, and the subscription lifetime past which the ramp resets. */
    public const NOTIFICATIONS_MAX_BACKOFF_SECONDS = 60;

    /** @var callable(array{payment_hash: string, paid_at: int, details: ?array<string, mixed>}): mixed */
    private $settlementHook;
    /** @var callable(): int */
    private $clock;

    /**
     * @param callable(array{payment_hash: string, paid_at: int, details: ?array<string, mixed>}): mixed $settlementHook write-once settlement + onPaid
     * @param bool|array{min_interval_seconds?: int} $opportunisticReconcile
     * @param (callable(): int)|null $clock
     */
    public function __construct(
        private readonly Service $service,
        private readonly PaymentRepository $repository,
        callable $settlementHook,
        private readonly bool|array $opportunisticReconcile = true,
        private readonly ?LoggerInterface $logger = null,
        ?callable $clock = null,
    ) {
        $this->settlementHook = $settlementHook;
        $this->clock = $clock ?? static fn (): int => time();
    }

    /**
     * One bounded reconciliation pass: scan the wallet for every pending
     * attempt, deliver settlements through the settlement hook, persist
     * terminal transitions. Returns the per-hash results so payments/check can
     * serve the requested hash straight from the pass.
     *
     * @return list<array<string, mixed>>
     */
    public function reconcile(int $overlapSeconds = 60, ?int $now = null, ?int $maxPages = null, ?float $deadline = null): array
    {
        $attempts = $this->repository->reconcilableAttempts();
        if ($attempts === []) {
            return [];
        }
        $observedAt = $now ?? ($this->clock)();
        $request = ['attempts' => $attempts, 'overlap_seconds' => $overlapSeconds, 'until' => $observedAt + $overlapSeconds];
        if ($maxPages !== null) {
            $request['max_pages'] = $maxPages;
        }
        if ($deadline !== null) {
            $request['deadline'] = $deadline;
        }
        $results = $this->service->reconcilePayments($request);
        $this->logPass($attempts, $results, $overlapSeconds, $observedAt);
        $byHash = [];
        foreach ($attempts as $attempt) {
            $byHash[$attempt['payment_hash']] = $attempt;
        }
        foreach ($results as $checked) {
            $attempt = $byHash[$checked['payment_hash']] ?? null;
            if ($attempt === null) {
                continue;
            }
            if (($checked['status'] ?? null) === 'settled' && isset($checked['paid_at'])) {
                $this->settleAttempt($checked);
            } else {
                $this->recordTransition($attempt, $checked, $observedAt);
            }
        }
        return $results;
    }

    /**
     * Opportunistic settlement discovery, piggybacked on any OpenReceive call:
     * skip without a wallet call when nothing is pending, claim the durable
     * gate shared by every worker (`gate_busy` means another worker just
     * scanned), otherwise AWAIT one bounded pass. Never throws: a failed scan
     * is `scan_failed`, and claimed_at stays in place so a broken wallet cannot stampede.
     *
     * @return array{reason: string, checks?: list<array<string, mixed>>}
     */
    public function maybeReconcile(?int $now = null): array
    {
        if ($this->opportunisticReconcile === false) {
            return ['reason' => 'disabled'];
        }
        try {
            $attempts = $this->repository->reconcilableAttempts();
            if ($attempts === []) {
                return ['reason' => 'no_pending'];
            }
            $observedAt = $now ?? ($this->clock)();
            $interval = $this->gateIntervalSeconds($attempts, $observedAt);
            if (!$this->repository->claimReconcileGate($observedAt, $interval)) {
                $this->logger?->debug(sprintf('[openreceive] opportunistic reconcile: gate_busy (%d pending, interval %ds)', count($attempts), $interval));
                return ['reason' => 'gate_busy'];
            }
            $checks = $this->reconcile(60, $observedAt, self::RECONCILE_SCAN_MAX_PAGES, hrtime(true) / 1e9 + self::RECONCILE_SCAN_TIMEOUT_SECONDS);
            return ['reason' => 'ran', 'checks' => $checks];
        } catch (\Throwable $e) {
            $this->logger?->warning('[openreceive] opportunistic reconcile failed (will retry): ' . self::sanitizeFailureMessage($e));
            return ['reason' => 'scan_failed'];
        }
    }

    /**
     * One NWC-02 payload: `payment_received` that satisfies the settlement
     * rule and matches a pending attempt settles directly; anything less
     * falls back to one bounded pass. Other types are ignored.
     *
     * @param array<string, mixed> $notification
     */
    public function handleNotification(array $notification): void
    {
        $type = $notification['notification_type'] ?? $notification['type'] ?? null;
        if ($type !== 'payment_received') {
            return;
        }
        if (!$this->settleFromNotification($notification)) {
            $this->reconcile();
        }
    }

    /**
     * Direct settlement from one authenticated payment_received payload.
     * True only when the payload, normalized like a list_transactions row,
     * satisfies the shared settlement rule AND matches a pending attempt.
     *
     * @param array<string, mixed> $notification
     */
    public function settleFromNotification(array $notification): bool
    {
        try {
            $payload = $notification['notification'] ?? null;
            if (!Records::isRecord($payload)) {
                return false;
            }
            $transaction = Requests::normalizeTransaction($payload);
            if (Settlement::status($transaction) !== 'settled') {
                return false;
            }
            $hash = strtolower((string) ($transaction['payment_hash'] ?? ''));
            if ($hash === '' || $this->repository->findPendingAttempt($hash) === null) {
                return false;
            }
            $observedAt = ($this->clock)();
            ($this->settlementHook)([
                'payment_hash' => $hash,
                'paid_at' => $transaction['settled_at'] ?? $observedAt,
                'details' => [
                    'transaction' => $transaction,
                    'observed_at' => $observedAt,
                    'paid_at_source' => isset($transaction['settled_at']) ? 'settled_at' : 'observed_at',
                ],
            ]);
            return true;
        } catch (\Throwable $e) {
            // A direct-settlement failure falls back to the scan-based safety net.
            $this->logger?->warning('[openreceive] direct settlement from notification failed (falling back to a scan): ' . self::sanitizeFailureMessage($e));
            return false;
        }
    }

    /**
     * The persisted status of one attempt, for payments/check on a gate-busy request.
     *
     * @return array{status: string, paid_at?: int}|null
     */
    public function attemptStatus(string $paymentHash): ?array
    {
        $row = $this->repository->findByPaymentHash($paymentHash);
        if ($row === null) {
            return null;
        }
        $status = ['status' => $row->status];
        if ($row->paidAt !== null) {
            $status['paid_at'] = $row->paidAt;
        }
        return $status;
    }

    /**
     * Retry delay for the notifications worker's subscribe loop: doubles per
     * consecutive failure up to the cap; a subscription that stayed up at
     * least that long was healthy, so the next drop starts the ramp from scratch.
     */
    public static function notificationsRetryDelay(?int $previousDelay, float $subscribedSeconds): int
    {
        if ($previousDelay === null || $subscribedSeconds >= self::NOTIFICATIONS_MAX_BACKOFF_SECONDS) {
            return 1;
        }
        return min($previousDelay * 2, self::NOTIFICATIONS_MAX_BACKOFF_SECONDS);
    }

    /** Failure text can embed wallet credentials (an NWC URI inside a connect error); redact before it reaches a log. */
    public static function sanitizeFailureMessage(\Throwable $error): string
    {
        $text = $error::class . ': ' . $error->getMessage();
        $text = preg_replace('/nostr\+walletconnect:[^\s"\'`<>]+/', '[REDACTED_NWC]', $text) ?? $text;
        return preg_replace('/lightning\+swapconnect:[^\s"\'`<>]+/', '[REDACTED_LSC]', $text) ?? $text;
    }

    /** @param array<int, array{payment_hash: string, created_at: int, expires_at: int}> $attempts */
    public function gateIntervalSeconds(array $attempts, int $now): int
    {
        $floor = self::MIN_RECONCILE_INTERVAL_SECONDS;
        if (is_array($this->opportunisticReconcile) && isset($this->opportunisticReconcile['min_interval_seconds'])) {
            $floor = max((int) $this->opportunisticReconcile['min_interval_seconds'], $floor);
        }
        if ($attempts === []) {
            return $floor;
        }
        $stretch = PHP_INT_MAX;
        foreach ($attempts as $attempt) {
            $elapsed = max($now - $attempt['created_at'], 0);
            $stretch = min($stretch, $elapsed < 120 ? 2 : ($elapsed < 300 ? 6 : 12));
        }
        return max($floor, $stretch);
    }

    /**
     * One failing settlement must not abort the rest of the pass.
     *
     * @param array<string, mixed> $checked
     */
    private function settleAttempt(array $checked): void
    {
        try {
            ($this->settlementHook)(['payment_hash' => $checked['payment_hash'], 'paid_at' => $checked['paid_at'], 'details' => $checked['details'] ?? null]);
        } catch (\Throwable $e) {
            $this->logger?->warning("[openreceive] settlement for {$checked['payment_hash']} failed (will retry next pass): " . self::sanitizeFailureMessage($e));
        }
    }

    /** @param array{payment_hash: string, created_at: int, expires_at: int} $attempt @param array<string, mixed> $checked */
    private function recordTransition(array $attempt, array $checked, int $observedAt): void
    {
        $transaction = Records::asArray($checked['details']['transaction'] ?? null);
        $state = $transaction['transaction_state'] ?? null;
        $transition = Reconciliation::transition($attempt['expires_at'], (string) $checked['status'], $observedAt, is_string($state) ? $state : null);
        if ($transition === null) {
            return;
        }
        $this->repository->recordReconciliation($checked['payment_hash'], $transition['status'], $observedAt, $transition['reason']);
    }

    /** @param array<int, array{payment_hash: string, created_at: int, expires_at: int}> $attempts @param list<array<string, mixed>> $results */
    private function logPass(array $attempts, array $results, int $overlapSeconds, int $observedAt): void
    {
        if ($this->logger === null) {
            return;
        }
        try {
            $counts = [];
            foreach ($results as $checked) {
                $counts[(string) $checked['status']] = ($counts[(string) $checked['status']] ?? 0) + 1;
            }
            $decided = [];
            foreach (['settled', 'pending', 'not_found'] as $status) {
                if (($counts[$status] ?? 0) > 0) {
                    $decided[] = "{$counts[$status]} " . str_replace('_', ' ', $status);
                }
            }
            $scanned = count($results) === count($attempts) ? '' : ' of ' . count($attempts) . ' attempts';
            $created = array_column($attempts, 'created_at');
            $from = $created === [] ? 0 : max(min($created) - $overlapSeconds, 0);
            $this->logger->info(sprintf(
                '[openreceive] payment.reconcile.completed: %s%s attempt_count=%d window=%d..%d',
                $decided === [] ? '0 decided' : implode(', ', $decided),
                $scanned,
                count($attempts),
                $from,
                $observedAt + $overlapSeconds
            ));
        } catch (\Throwable) {
            // Diagnostics must never affect the pass.
        }
    }
}
