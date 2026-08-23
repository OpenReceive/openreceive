# Library-owned payment architecture

OpenReceive is a coordinator between two external ledgers: the merchant's receive wallet and,
when enabled, a swap provider. The host application's database is the application ledger;
OpenReceive owns the `openreceive_payments` table inside it — one row per attempt, host orders
unchanged. The host passes a database handle; the library owns the schema, per-reference commit
locking, the status state machine, and write-once settlement.

The durable correlation key is `payment_hash`. The attempt also stores the safe checkout
snapshot so an HTTP retry never depends on another wallet call. Wallet settlement is reconstructed
through batched `list_transactions` scans, deduplicated by hash with pages no larger than 20.
Creation time, not settlement time, defines scan ranges.

Reconciliation loads only `pending` attempts and scans their shared creation-time range, so the
window stays roughly the active invoice window. Terminal transitions
(`expired | failed | attention` plus `status_reason`) require a successful wallet scan; closing
an unpaid attempt additionally requires the scan to be at or after expiry plus the 900-second
grace. Restarting repeats safe, idempotent work rather than resuming a durable workflow cursor.

Swap workflow recovery is separate. The attempt row optionally stores a server-only `swap_data`
object containing provider name/order credentials.
OpenReceive never serializes it to a browser. Process caches only reduce calls and are never
correctness state.

Callbacks are at-least-once. Write-once settlement under the per-reference lock, with host
fulfillment (`onPaid`) running in the same transaction only for the order's first settled
attempt, is the replay guard; a sibling second settlement is recorded as
`duplicate_settlement`.
