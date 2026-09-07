<?php

declare(strict_types=1);

namespace OpenReceive\Payments;

use OpenReceive\Generated\Tables;

/**
 * Terminal-transition decisions for one non-settled reconciliation result.
 * Mirrors spec/test-vectors/attempt-reconciliation.json exactly: closure of
 * an unpaid attempt requires a successful wallet scan observed at or after
 * expiry plus the grace window — a local clock alone never closes a row.
 */
final class Reconciliation
{
    /**
     * Seconds past an attempt's expiry during which reconciliation still scans
     * for a settlement before closing the attempt. An exported constant from
     * the kernel tables (never an environment variable), pinned by the vector.
     */
    public const EXPIRY_GRACE_SECONDS = Tables::ATTEMPT_EXPIRY_GRACE_SECONDS;

    /**
     * Returns ['status' => …, 'reason' => …] to persist, or null to keep the
     * attempt pending. Settled results never reach this decision.
     * `$transactionState` is the explicit state field on the wallet's record,
     * when the scan found one.
     *
     * @return array{status: string, reason: string}|null
     */
    public static function transition(int $expiresAt, string $status, int $observedAt, ?string $transactionState = null): ?array
    {
        switch ($status) {
            case 'failed':
                return ['status' => 'failed', 'reason' => 'wallet_reported_failed'];
            case 'expired':
                return ['status' => 'expired', 'reason' => 'wallet_reported_expired'];
            case 'not_found':
            case 'pending':
                // The invoice may outlive the requested expiry, so closure waits
                // for a scan past expiry plus grace instead of trusting the local clock alone.
                if ($observedAt < $expiresAt + self::EXPIRY_GRACE_SECONDS) {
                    return null;
                }
                if ($status === 'not_found') {
                    return ['status' => 'expired', 'reason' => 'not_found_after_expiry'];
                }
                if (in_array($transactionState, ['pending', 'accepted'], true)) {
                    // `attention` requires the wallet's EXPLICIT claim that the
                    // transaction is still in flight long after expiry.
                    return ['status' => 'attention', 'reason' => 'unsettled_after_expiry'];
                }
                // A state-less record is indistinguishable from an ordinary
                // abandoned invoice — close it as expired.
                return ['status' => 'expired', 'reason' => 'no_finality_after_expiry'];
            default:
                throw new \InvalidArgumentException("unexpected reconciliation status: {$status}");
        }
    }
}
