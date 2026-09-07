<?php

declare(strict_types=1);

namespace OpenReceive;

use OpenReceive\Storage\DatabaseConnection;

/**
 * Passed to the host's `onPaid` inside the settlement transaction, only for
 * the reference's first settled attempt. `connection` is the transaction the
 * settlement is being written in: statements run through it commit together
 * with the payment record (see the generated fulfillment note).
 */
final class PaymentSettlement
{
    /** @param array<string, mixed>|null $details wallet-observed settlement details (transaction snapshot, observed_at, paid_at_source) */
    public function __construct(
        public readonly string $reference,
        public readonly string $paymentHash,
        public readonly int $paidAt,
        public readonly ?array $details,
        public readonly ?DatabaseConnection $connection = null,
    ) {
    }
}
