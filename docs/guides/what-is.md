# What is OpenReceive?

OpenReceive connects a host application to a receive-only NWC wallet and optional swap
providers. It creates invoices and verifies settlement, but it does not own payment records.

Your application remains the source of truth for orders, prices, fulfillment, and durable
state. Store `payment_hash` and nullable `paid_at` on the order you already have. For an
unresolved swap, also store the opaque recovery token.

OpenReceive deliberately has no database, Redis, migrations, storage adapters, or background
job ledger. Recovery comes from the external ledgers: look up known payment hashes or scan
overlapping NIP-47 creation-time ranges; query a swap provider with the sealed recovery token.

Settlement callbacks are at-least-once. Your host updates `paid_at` once by payment hash and
makes fulfillment idempotent.
