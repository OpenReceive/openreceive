<?php

declare(strict_types=1);

namespace OpenReceive\Storage;

use OpenReceive\Kernel;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\Errors\ConflictError;
use OpenReceive\Support\Integers;
use OpenReceive\Support\Records;

/**
 * Engine-owned payment attempts in the host's database, over the five-method
 * DatabaseConnection. The Rails OpenReceivePayment model's twin: an order may
 * have many historical attempts; each row is direct Lightning or exactly one
 * provider swap attempt; commitAttempt serializes on an OpenReceive-owned
 * per-reference lock; settlement is write-once; "already paid" means any
 * settled row; live means status pending and unexpired. Hosts never see the
 * live/supersede/conflict vocabulary — they see an order as unpaid or paid.
 */
final class SqlPaymentRepository implements PaymentRepository
{
    public const REUSE_BUFFER_SECONDS = 60;
    /**
     * Oldest-first page size for one reconciliation pass: a backlog of pending
     * attempts drains over several passes instead of loading every row.
     */
    public const RECONCILE_BATCH_SIZE = 200;
    /**
     * Namespacing seed for the postgres per-reference advisory lock. Identical
     * to the JS repository and the Rails model, so a database served by more
     * than one engine still serializes one reference's commits.
     */
    public const ADVISORY_LOCK_SEED = 8_210_223;
    public const MYSQL_LOCK_TIMEOUT_SECONDS = 10;

    private const ALREADY_PAID = 'This reference is already paid.';
    private const LIVE_CONFLICT = 'An unpaid checkout for this payment method is already in progress for this reference.';
    private const MULTI_LIVE_CONFLICT = 'This reference has multiple unpaid checkouts in progress for this payment method; wait for them to expire before creating another.';

    private readonly MetaStore $meta;
    /** @var callable(): int */
    private $clock;

    /** @param (callable(): int)|null $clock */
    public function __construct(
        private readonly DatabaseConnection $db,
        ?callable $clock = null,
        private readonly string $table = PaymentsSchema::DEFAULT_TABLE,
        string $metaTable = PaymentsSchema::DEFAULT_META_TABLE,
    ) {
        PaymentsSchema::assertIdentifier($table);
        $this->meta = new MetaStore($db, $metaTable);
        $this->clock = $clock ?? static fn (): int => time();
    }

    public function meta(): MetaStore
    {
        return $this->meta;
    }

    public function connection(): DatabaseConnection
    {
        return $this->db;
    }

    public function listForReference(string $reference): array
    {
        $this->meta->assertSupportedSchema();
        return $this->rowsForReference($this->db, $reference);
    }

    public function findByPaymentHash(string $paymentHash): ?PaymentRecord
    {
        $this->meta->assertSupportedSchema();
        return $this->findByHash($this->db, strtolower(trim($paymentHash)));
    }

    public function selectedFor(string $reference, string $action, ?string $paymentHash = null, ?string $payInAsset = null, ?int $now = null): ?PaymentRecord
    {
        $this->meta->assertSupportedSchema();
        $now ??= ($this->clock)();
        if ($paymentHash !== null && trim($paymentHash) !== '') {
            $selected = $this->findByHash($this->db, strtolower(trim($paymentHash)));
            return $selected?->reference === $reference ? $selected : null;
        }
        $attempts = $this->rowsForReference($this->db, $reference);
        if (in_array($action, ['checkout.create', 'swap.create'], true)) {
            if (self::anySettled($attempts)) {
                throw new ConflictError(self::ALREADY_PAID);
            }
            $matching = array_values(array_filter(
                self::liveAt($attempts, $now),
                static fn (PaymentRecord $row): bool => self::matchesCreateAction($row, $action, $payInAsset)
            ));
            if (count($matching) > 1) {
                throw new ConflictError(self::MULTI_LIVE_CONFLICT);
            }
            $selected = $matching[0] ?? null;
            if ($selected === null || !self::isReusable($selected, $now)) {
                return null;
            }
            return $selected;
        }
        if (in_array($action, ['swap.read', 'swap.refund'], true)) {
            $attempts = array_values(array_filter($attempts, static fn (PaymentRecord $row): bool => $row->isSwap()));
        }
        return $attempts[0] ?? null;
    }

    public function commitAttempt(string $reference, string $paymentHash, array $checkout, ?array $swapData = null, ?string $clientIp = null): PaymentRecord
    {
        $this->meta->assertSupportedSchema();
        $hash = strtolower($paymentHash);
        if (preg_match(Kernel::LOWER_HEX_64_PATTERN, $hash) !== 1) {
            throw new \InvalidArgumentException('invalid payment_hash');
        }
        if ($reference === '') {
            throw new \InvalidArgumentException('reference is required');
        }
        $checkout = Records::asArray($checkout);
        $swapData = $swapData === null || $swapData === [] ? null : Records::asArray($swapData);
        return $this->withReferenceLock($reference, function (DatabaseConnection $tx) use ($reference, $hash, $checkout, $swapData, $clientIp): PaymentRecord {
            $same = $this->findByHash($tx, $hash);
            if ($same !== null) {
                if ($same->reference !== $reference) {
                    throw new ConflictError('payment hash belongs to another reference');
                }
                return $same;
            }
            $existing = $this->rowsForReference($tx, $reference);
            if (self::anySettled($existing)) {
                throw new ConflictError(self::ALREADY_PAID);
            }
            $now = ($this->clock)();
            foreach (self::liveAt($existing, $now) as $live) {
                $decision = self::liveAttemptCommitDecision($live, $swapData, $now);
                if ($decision === 'conflict') {
                    throw new ConflictError(self::LIVE_CONFLICT);
                }
                if ($decision === 'supersede') {
                    // Marked, not closed: the invoice stays payable until it expires
                    // wallet-side, and closing it here on the local clock would drop it
                    // out of the scan set, so funds paid to it could never be matched.
                    $tx->execute(
                        "UPDATE {$this->table} SET status_reason = 'superseded', updated_at = ? WHERE payment_hash = ? AND status = 'pending'",
                        [Timestamps::toDb($now), $live->paymentHash]
                    );
                }
            }
            $createdAt = self::attemptCreatedAt($checkout);
            $expiresAt = self::attemptExpiresAt($checkout, $swapData);
            $tx->execute(
                "INSERT INTO {$this->table} (reference, payment_hash, status, status_reason, paid_at, expires_at, checkout_data, swap_data, client_ip, inserted_at, created_at, updated_at)\n"
                . "VALUES (?, ?, 'pending', NULL, NULL, ?, ?, ?, ?, ?, ?, ?)",
                [
                    $reference,
                    $hash,
                    Timestamps::toDb($expiresAt),
                    json_encode($checkout, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
                    $swapData === null ? null : json_encode($swapData, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
                    $clientIp === null || trim($clientIp) === '' ? null : $clientIp,
                    Timestamps::toDb($now),
                    Timestamps::toDb($createdAt),
                    Timestamps::toDb($now),
                ]
            );
            $inserted = $this->findByHash($tx, $hash);
            if ($inserted === null) {
                throw new \RuntimeException('committed attempt row could not be read back');
            }
            return $inserted;
        });
    }

    public function countAttemptsFromIp(string $clientIp, int $since): int
    {
        // inserted_at is stamped once from the local clock and never changes:
        // created_at is the wallet-reported invoice time and updated_at moves on
        // every status transition (spec/test-vectors/rate-limit-window.json).
        $rows = $this->db->query(
            "SELECT COUNT(*) AS n FROM {$this->table} WHERE client_ip = ? AND inserted_at >= ?",
            [$clientIp, Timestamps::toDb($since)]
        );
        return Integers::parse($rows[0]['n'] ?? 0, 'n');
    }

    public function markPaidOnce(string $paymentHash, int $paidAt, ?array $details, callable $fulfill): bool
    {
        $this->meta->assertSupportedSchema();
        $hash = strtolower($paymentHash);
        $payment = $this->findByHash($this->db, $hash);
        if ($payment === null) {
            return false;
        }
        return $this->withReferenceLock($payment->reference, function (DatabaseConnection $tx) use ($hash, $paidAt, $details, $fulfill): bool {
            $rows = $this->rowsForReference($tx, $this->requireReference($tx, $hash));
            $row = null;
            foreach ($rows as $candidate) {
                if ($candidate->paymentHash === $hash) {
                    $row = $candidate;
                }
            }
            if ($row === null || $row->status === 'settled') {
                return false;
            }
            $firstForReference = !self::anySettled($rows);
            $now = ($this->clock)();
            $tx->execute(
                "UPDATE {$this->table} SET status = 'settled', status_reason = ?, paid_at = ?, updated_at = ? WHERE payment_hash = ?",
                [$firstForReference ? null : 'duplicate_settlement', Timestamps::toDb($paidAt), Timestamps::toDb($now), $hash]
            );
            if ($firstForReference) {
                $fulfill(new PaymentSettlement($row->reference, $hash, $paidAt, $details, $tx));
            }
            return $firstForReference;
        });
    }

    public function recordReconciliation(string $paymentHash, string $status, int $observedAt, string $reason): void
    {
        $this->meta->assertSupportedSchema();
        if (!in_array($status, ['expired', 'failed', 'attention'], true)) {
            throw new \InvalidArgumentException("invalid reconciliation status: {$status}");
        }
        // Guarding on status = 'pending' makes the transition idempotent and
        // guarantees a settled attempt is never overwritten.
        $this->db->execute(
            "UPDATE {$this->table} SET status = ?, status_reason = ?, updated_at = ? WHERE payment_hash = ? AND status = 'pending'",
            [$status, $reason, Timestamps::toDb($observedAt), strtolower($paymentHash)]
        );
    }

    public function reconcilableAttempts(): array
    {
        $this->meta->assertSupportedSchema();
        $rows = $this->db->query(
            "SELECT payment_hash, created_at, expires_at FROM {$this->table} WHERE status = 'pending' ORDER BY created_at ASC, payment_hash ASC LIMIT ?",
            [self::RECONCILE_BATCH_SIZE]
        );
        return array_map(static fn (array $row): array => self::attemptFromRow($row), $rows);
    }

    public function findPendingAttempt(string $paymentHash): ?array
    {
        $this->meta->assertSupportedSchema();
        $rows = $this->db->query(
            "SELECT payment_hash, created_at, expires_at FROM {$this->table} WHERE payment_hash = ? AND status = 'pending'",
            [strtolower($paymentHash)]
        );
        return $rows === [] ? null : self::attemptFromRow($rows[0]);
    }

    public function claimReconcileGate(int $now, int $intervalSeconds): bool
    {
        return $this->meta->claimReconcileGate($now, $intervalSeconds);
    }

    /**
     * The per-reference serialization boundary for commit and settlement.
     * Postgres: a transaction-scoped advisory lock with the shared seed.
     * MySQL: GET_LOCK is session-scoped, so it is taken before BEGIN and
     * released after COMMIT — releasing inside would leave a window where a
     * second worker commits against state this one already read. SQLite:
     * BEGIN IMMEDIATE serializes writers; the payment_hash UNIQUE index is the
     * backstop on every dialect.
     *
     * @template T
     * @param callable(DatabaseConnection): T $fn
     * @return T
     */
    public function withReferenceLock(string $reference, callable $fn): mixed
    {
        if ($reference === '') {
            throw new \InvalidArgumentException('reference is required');
        }
        if ($this->db->dialect() === 'mysql') {
            $name = 'openreceive:' . substr(hash('sha256', $reference), 0, 40);
            $acquired = $this->db->query('SELECT GET_LOCK(?, ?) AS acquired', [$name, self::MYSQL_LOCK_TIMEOUT_SECONDS]);
            if ((int) ($acquired[0]['acquired'] ?? 0) !== 1) {
                throw new \RuntimeException('Timed out taking the OpenReceive lock for this reference.');
            }
            try {
                return $this->db->transaction($fn);
            } finally {
                $this->db->query('SELECT RELEASE_LOCK(?) AS released', [$name]);
            }
        }
        return $this->db->transaction(function (DatabaseConnection $tx) use ($reference, $fn): mixed {
            if ($tx->dialect() === 'pgsql') {
                $tx->query('SELECT pg_advisory_xact_lock(hashtextextended(?, ?))', [$reference, self::ADVISORY_LOCK_SEED]);
            }
            return $fn($tx);
        });
    }

    /** @param array<string, mixed>|null $incomingSwapData @return 'conflict'|'supersede'|'ignore' */
    public static function liveAttemptCommitDecision(PaymentRecord $live, ?array $incomingSwapData, int $now): string
    {
        $incomingAsset = $incomingSwapData['provider_order']['pay_in_asset'] ?? null;
        $incomingIsSwap = $incomingSwapData !== null && $incomingSwapData !== [];
        if ($live->isSwap() !== $incomingIsSwap) {
            return 'ignore';
        }
        if ($incomingIsSwap && $live->swapPayInAsset() !== (is_string($incomingAsset) ? $incomingAsset : null)) {
            return 'ignore';
        }
        return self::isReusable($live, $now) ? 'conflict' : 'supersede';
    }

    public static function isReusable(PaymentRecord $payment, int $now): bool
    {
        return $payment->expiresAt - $now > self::REUSE_BUFFER_SECONDS;
    }

    /** @param list<PaymentRecord> $rows */
    private static function anySettled(array $rows): bool
    {
        foreach ($rows as $row) {
            if ($row->status === 'settled') {
                return true;
            }
        }
        return false;
    }

    /**
     * A superseded row stays pending so the wallet scan keeps covering it, but
     * it is no longer offered to a payer — so it neither blocks a new attempt
     * nor is superseded again.
     *
     * @param list<PaymentRecord> $rows
     * @return list<PaymentRecord>
     */
    private static function liveAt(array $rows, int $now): array
    {
        return array_values(array_filter(
            $rows,
            static fn (PaymentRecord $row): bool => $row->status === 'pending' && $row->expiresAt > $now && $row->statusReason !== 'superseded'
        ));
    }

    private static function matchesCreateAction(PaymentRecord $payment, string $action, ?string $payInAsset): bool
    {
        if ($action === 'checkout.create') {
            return !$payment->isSwap();
        }
        if (!$payment->isSwap()) {
            return false;
        }
        return $payInAsset === null || $payInAsset === '' || $payment->swapPayInAsset() === $payInAsset;
    }

    /** @param array<string, mixed> $checkout @param array<string, mixed>|null $swapData */
    private static function attemptExpiresAt(array $checkout, ?array $swapData): int
    {
        $providerExpiry = $swapData['provider_order']['expires_at'] ?? null;
        return Integers::parse($providerExpiry ?? $checkout['expires_at'] ?? $checkout['expiresAt'] ?? null, 'expires_at');
    }

    /** @param array<string, mixed> $checkout */
    private static function attemptCreatedAt(array $checkout): int
    {
        return Integers::parse($checkout['created_at'] ?? $checkout['createdAt'] ?? null, 'created_at');
    }

    /** @return list<PaymentRecord> */
    private function rowsForReference(DatabaseConnection $db, string $reference): array
    {
        $rows = $db->query(
            "SELECT * FROM {$this->table} WHERE reference = ? ORDER BY created_at DESC, payment_hash DESC",
            [$reference]
        );
        return array_map([self::class, 'recordFromRow'], $rows);
    }

    private function findByHash(DatabaseConnection $db, string $hash): ?PaymentRecord
    {
        $rows = $db->query("SELECT * FROM {$this->table} WHERE payment_hash = ?", [$hash]);
        return $rows === [] ? null : self::recordFromRow($rows[0]);
    }

    private function requireReference(DatabaseConnection $db, string $hash): string
    {
        $rows = $db->query("SELECT reference FROM {$this->table} WHERE payment_hash = ?", [$hash]);
        return (string) ($rows[0]['reference'] ?? '');
    }

    /** @param array<string, mixed> $row */
    private static function recordFromRow(array $row): PaymentRecord
    {
        $hash = (string) $row['payment_hash'];
        $swap = $row['swap_data'] ?? null;
        return new PaymentRecord(
            (string) $row['reference'],
            $hash,
            (string) $row['status'],
            isset($row['status_reason']) ? (string) $row['status_reason'] : null,
            Timestamps::optionalFromDb($row['paid_at'] ?? null, 'paid_at'),
            Timestamps::fromDb($row['expires_at'], 'expires_at'),
            Timestamps::fromDb($row['created_at'], 'created_at'),
            Timestamps::fromDb($row['inserted_at'], 'inserted_at'),
            self::parseRowJson((string) $row['checkout_data'], 'checkout_data', $hash),
            $swap === null || $swap === '' ? null : self::parseRowJson((string) $swap, 'swap_data', $hash),
            isset($row['client_ip']) ? (string) $row['client_ip'] : null,
        );
    }

    /**
     * The message carries the column and payment hash only — never the value,
     * which may hold server-only swap credentials.
     *
     * @return array<string, mixed>
     */
    private static function parseRowJson(string $value, string $column, string $hash): array
    {
        $parsed = json_decode($value, true);
        if (!is_array($parsed)) {
            throw new \RuntimeException("Corrupt {$column} JSON on openreceive payment attempt {$hash}; the row cannot be read.");
        }
        return Records::asArray($parsed);
    }

    /**
     * @param array<string, mixed> $row
     * @return array{payment_hash: string, created_at: int, expires_at: int}
     */
    private static function attemptFromRow(array $row): array
    {
        return [
            'payment_hash' => (string) $row['payment_hash'],
            'created_at' => Timestamps::fromDb($row['created_at'], 'created_at'),
            'expires_at' => Timestamps::fromDb($row['expires_at'], 'expires_at'),
        ];
    }
}
