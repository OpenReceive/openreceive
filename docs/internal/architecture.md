# Host-owned payment architecture

OpenReceive is a stateless coordinator between two external ledgers: the merchant's receive
wallet and, when enabled, a swap provider. The host application's database is the application
ledger; `openreceive_payments` stores one row per attempt without changing host orders.

The durable correlation key is `payment_hash`. The attempt also stores the safe checkout
snapshot so an HTTP retry never depends on another wallet call. Wallet settlement is reconstructed
through batched `list_transactions` scans, deduplicated by hash with pages no larger than 20.
Creation time, not settlement time, defines scan ranges.

Reconciliation reloads unsettled host attempts and scans their shared creation-time range.
Restarting repeats safe, idempotent work rather than resuming a durable workflow cursor.

Swap workflow recovery is separate. The attempt row optionally stores a server-only `swap_data`
object containing provider name/order credentials.
OpenReceive never serializes it to a browser. Process caches only reduce calls and are never
correctness state.

Callbacks are at-least-once. Write-once attempt `paid_at`, an order lock, and first-settlement
fulfillment in the same transaction (or a transactional outbox insert) are the replay guard.
