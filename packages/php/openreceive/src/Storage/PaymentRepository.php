<?php

declare(strict_types=1);

namespace OpenReceive\Storage;

use OpenReceive\PaymentSettlement;

/**
 * The library-owned payment-attempt ledger. SqlPaymentRepository is the
 * shipped implementation; a custom implementation is the documented escape
 * hatch (never the quickstart) for a host whose storage PDO cannot reach.
 * Every method may throw ConflictError for the payer-facing refusals the
 * engine defines (already paid, live attempt on the same rail).
 */
interface PaymentRepository
{
    /**
     * Newest first, ties on payment_hash descending.
     *
     * @return list<PaymentRecord>
     */
    public function listForReference(string $reference): array;

    /** One attempt by its globally unique hash (any status), or null. */
    public function findByPaymentHash(string $paymentHash): ?PaymentRecord;

    /**
     * The attempt a mounted route is about: an exact hash when the payer named
     * one; for the create actions the reusable live attempt on that rail (or
     * null to mint); for the swap read/refund actions the newest swap attempt.
     */
    public function selectedFor(string $reference, string $action, ?string $paymentHash = null, ?string $payInAsset = null, ?int $now = null): ?PaymentRecord;

    /**
     * Commit one attempt row before payer instructions are exposed,
     * serialized per reference. Idempotent for a repeated payment_hash.
     *
     * @param array<string, mixed> $checkout
     * @param array<string, mixed>|null $swapData
     */
    public function commitAttempt(string $reference, string $paymentHash, array $checkout, ?array $swapData = null, ?string $clientIp = null): PaymentRecord;

    /** Attempt rows for one client IP inserted at or after `$since` (the rate-limit window on `inserted_at`). */
    public function countAttemptsFromIp(string $clientIp, int $since): int;

    /**
     * Write-once settlement. `$fulfill` runs INSIDE the settlement transaction
     * and only for the reference's first settled attempt; a later sibling is
     * recorded with status_reason `duplicate_settlement` and never fulfills.
     * Returns whether this call fulfilled.
     *
     * @param array<string, mixed>|null $details
     * @param callable(PaymentSettlement): void $fulfill
     */
    public function markPaidOnce(string $paymentHash, int $paidAt, ?array $details, callable $fulfill): bool;

    /** Apply a terminal reconciliation transition while the row is still pending (idempotent). */
    public function recordReconciliation(string $paymentHash, string $status, int $observedAt, string $reason): void;

    /**
     * Pending attempts for the next wallet scan, oldest first, one batch per pass.
     *
     * @return list<array{payment_hash: string, created_at: int, expires_at: int}>
     */
    public function reconcilableAttempts(): array;

    /**
     * A pending attempt by hash — the notification shortcut must not wait for a backlog.
     *
     * @return array{payment_hash: string, created_at: int, expires_at: int}|null
     */
    public function findPendingAttempt(string $paymentHash): ?array;

    /** The durable reconcile gate: true when this caller may scan the wallet now. */
    public function claimReconcileGate(int $now, int $intervalSeconds): bool;
}
