# What is OpenReceive?

OpenReceive connects a host application to a receive-only NWC wallet and optional swap
providers. It creates invoices and verifies settlement; the host owns the payment records.

Your application remains the source of truth for orders, prices, fulfillment, and durable
state. Keep orders unchanged and store one `openreceive_payments` row per invoice/swap attempt.
Rows contain `order_id`, `payment_hash`, nullable `paid_at`, `expires_at`, and optional
server-only provider `swap_data`.

OpenReceive's runtime deliberately accepts no database/Redis URL or storage adapter. Recovery
comes from external ledgers plus host-owned attempt rows: look up known payment hashes or scan
overlapping NIP-47 creation-time ranges; query a swap provider with host-loaded `swap_data`.

Settlement callbacks are at-least-once. Your host updates each attempt's `paid_at` once by
payment hash and fulfills only for the order's first settled attempt.
