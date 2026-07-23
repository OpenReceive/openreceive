# ADR-0007: At-least-once verified payment delivery

Status: Accepted (supersedes persisted settlement-action leases)

OpenReceive emits `{ paymentHash, paidAt, details? }` after wallet verification. Delivery is
at-least-once and may repeat after callback failure, restart, overlapping scans, or multiple
instances.

The host sets `paid_at` only when null and couples fulfillment to its own idempotent transaction
or job. OpenReceive does not persist callback state or claim leases.
