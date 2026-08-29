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

## NWC credential and preflight

An NWC code is a [NIP-47 connection string](https://github.com/nostr-protocol/nips/blob/master/47.md#nostr-wallet-connect-uri):

```text
nostr+walletconnect://<wallet pubkey>?relay=wss://…&secret=<64-hex client secret>
```

The `secret` is a Nostr private key the wallet service minted for this one
connection — not the wallet's key. Every call is an encrypted Nostr event
(NIP-04 or NIP-44 v2) through the listed relay. The wallet service decides,
per connection, which methods that client key may invoke.

A **receive-only** connection may call `make_invoice` and `list_transactions`
(required), typically plus `lookup_invoice`, `get_info`, and
`payment_received` notifications. It is refused `pay_invoice`,
`multi_pay_invoice`, `pay_keysend`, and `multi_pay_keysend`. The `multi_pay_*`
methods were dropped from NIP-47 in February 2026, but wallets still advertise
them, so preflight still treats them as spend methods.

Whoever holds the secret can do exactly that set and nothing more. An attacker
who takes it can mint invoices payable *to* the merchant wallet and read
history; they cannot move a satoshi, because the refusal lives at the wallet.
OpenReceive exposes no send-payment method. The spend-capable override only
widens the damage a leak could do from another NIP-47 client.

### What preflight proves

Preflight reads this connection's own method list from NIP-47 `get_info` — not
the wallet service's kind-13194 info event, which advertises the service at
large. The event only supplies encryption modes, and stands in for the method
list when a client has no `get_info` (logged as
`nwc.info_event.methods_fallback`). Both engines then check, in order:

1. `make_invoice` and `list_transactions` are advertised — otherwise
   `missing_required_method`.
2. The wallet speaks NIP-04 or NIP-44 v2 — otherwise `unsupported_encryption`.
3. No spend method is advertised — otherwise `spend_capability_advertised`,
   and the application refuses to start. With the override set, startup
   continues after an `nwc.spend_capability_advertised` error log and a loud
   console warning.

A wallet that cannot answer `get_info` also stops the application from
starting. Node surfaces this as `ConfigError` (`WALLET_PREFLIGHT_FAILED`)
before `createOpenReceive()` resolves. Framework adapters run preflight
lazily (the first request awaits it); the Rails engine runs it eagerly in
production. See [Deployment state](deployment-storage.md).

The relay is a transport, not a trust anchor. A hostile or dead relay can
delay or drop traffic; it cannot forge settlement, because responses are
encrypted between the client key and the wallet pubkey. Direct settlement
from a notification assumes the client binds decryption to the connection's
wallet pubkey (the bundled Alby JS SDK does).

The integrator-facing rules are in [Security](../guides/security.md).
