# ADR-0003: Invoice, Idempotency, And Storage Invariants

## Status

Accepted for v0.1.

## Context

Receive checkout must be replay-safe. Duplicate requests, duplicate status
refreshes, reconnects, and settlement action retries must not double-credit a
customer.

## Decision

Every invoice record is stored as `{ rev, row }` through the
`OpenReceiveInvoiceKvStore` contract. The row stores `invoice_id`,
`namespace`, `operation`, `idempotency_key`,
`idempotency_request_hash`, `payment_hash`, `invoice`, `amount_msats`,
`transaction_state`, `workflow_state`, `settlement_action_state`, timestamps,
metadata, transaction-scan fields, settlement-action lease fields, and fiat quote
data when used.

The canonical idempotency scope is:

```text
namespace + operation + idempotency_key
```

Reusing a key with the same request hash returns the original invoice. Reusing
the key with a different request hash returns conflict.

Settlement and settlement action transitions are idempotent.
`settlement_action_completed_at` can be set once. Refresh creates a new invoice
linked to the old invoice.

## Consequences

- SDKs and adapters must expose idempotency behavior.
- Storage adapters need atomic uniqueness for `invoice_id`, `payment_hash`,
  BOLT11 invoice, and idempotency scope.
- Store adapters are dumb persistence; lifecycle guards live in core pure
  transition functions.
- Settlement actions are delivered at least once and must be app-idempotent by
  `payment_hash`.
- Test vectors define lifecycle and idempotency behavior.
