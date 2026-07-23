# Settlement reconciliation

There is no OpenReceive sweep table or privileged sweep route. Recovery has two forms:

1. The host selects orders where `payment_hash IS NOT NULL AND paid_at IS NULL` and calls
   `reconcilePayments`.
2. `watchPayments` scans overlapping wallet creation-time windows and invokes `onPaid`; the
   host ignores unknown hashes.

Both paths require wallet settlement authority and deliver at least once. Failed callbacks are
retried when scans rediscover the payment. Pending results are mutable; settled facts are final.
