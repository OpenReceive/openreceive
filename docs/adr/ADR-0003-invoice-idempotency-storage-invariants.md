# ADR-0003: Invoice, Idempotency, And Storage Invariants

## Status

Accepted for v0.1.

## Context

Receive checkout must be replay-safe. Duplicate requests, duplicate
notifications, reconnects, and settlement action retries must not double-credit
a customer.

## Decision

Every invoice row stores `invoice_id`, `merchant_scope`, `idempotency_key`,
`idempotency_request_hash`, `payment_hash`, `invoice`, `amount_msats`,
`transaction_state`, `workflow_state`, `settlement_action_state`, timestamps,
metadata, and fiat quote data when used.

The canonical idempotency scope is:

```text
merchant_scope + operation + idempotency_key
```

Reusing a key with the same request hash returns the original invoice. Reusing
the key with a different request hash returns conflict.

Settlement and settlement action transitions are idempotent.
`settlement_action_completed_at` can be set once. Refresh creates a new invoice
linked to the old invoice.

## Consequences

- SDKs and adapters must expose idempotency behavior.
- Storage adapters need unique `invoice_id` and `payment_hash` constraints.
- Notifications never run settlement actions directly.
- Test vectors define lifecycle and idempotency behavior.
