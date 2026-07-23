# Storage-free architecture

OpenReceive is a stateless coordinator between two external ledgers: the merchant's receive
wallet and, when enabled, a swap provider. The host application's order database is the only
application ledger.

The durable correlation key is `payment_hash`. Wallet settlement is reconstructed through
`lookup_invoice` or overlapping `list_transactions` scans, deduplicated by hash with pages no
larger than 20. Creation time, not settlement time, defines scan ranges.

Swap workflow recovery is separate. An authenticated encrypted recovery token contains the
provider name/order credentials plus the bound order ID and payment hash. The host optionally
stores that opaque token. Process caches only reduce calls and are never correctness state.

Callbacks are at-least-once. The host's write-once `paid_at` and fulfillment transaction are
the replay guard.
