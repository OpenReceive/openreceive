# Host-owned payment architecture

OpenReceive is a stateless coordinator between two external ledgers: the merchant's receive
wallet and, when enabled, a swap provider. The host application's database is the application
ledger; `openreceive_payments` stores one row per attempt without changing host orders.

The durable correlation key is `payment_hash`. Wallet settlement is reconstructed through
`lookup_invoice` or overlapping `list_transactions` scans, deduplicated by hash with pages no
larger than 20. Creation time, not settlement time, defines scan ranges.

Swap workflow recovery is separate. The attempt row optionally stores a server-only `swap_data`
object containing provider name/order credentials.
OpenReceive never serializes it to a browser. Process caches only reduce calls and are never
correctness state.

Callbacks are at-least-once. Write-once attempt `paid_at`, an order lock, and first-settlement
fulfillment are the replay guard.
