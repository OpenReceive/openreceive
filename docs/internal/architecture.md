# Library-owned payment architecture

OpenReceive coordinates between two external ledgers: the merchant's receive wallet and,
when enabled, a swap provider. The host application's database is the application ledger.
OpenReceive owns the `openreceive_payments` table inside it. That table has one row per attempt,
and the host's orders stay unchanged. The host passes in a database handle. The library owns the
schema, the commit lock per reference, the status state machine, and write-once settlement.

`payment_hash` is the durable key that links an attempt to the wallet. The attempt also stores
the safe checkout snapshot, so an HTTP retry never needs another wallet call. OpenReceive
rebuilds wallet settlement from batched `list_transactions` scans. It deduplicates results by
hash and uses pages of at most 20. Scan ranges are defined by creation time, not settlement time.

Reconciliation loads only `pending` attempts and scans their shared creation-time range. The
scan window therefore stays close to the window of active invoices. Terminal transitions
(`expired | failed | attention` plus `status_reason`) require a successful wallet scan. To close
an unpaid attempt, that scan must also happen at or after expiry plus the 900-second grace.
A restart repeats safe, idempotent work. It does not resume a durable workflow cursor.

Swap workflow recovery is separate. The attempt row can store a server-only `swap_data`
object that holds the provider name and order credentials.
OpenReceive never serializes it to a browser. Process caches only reduce calls. Correctness never
depends on them.

Callbacks are delivered at least once. The replay guard is write-once settlement under the
per-reference lock. Host fulfillment (`onPaid`) runs in the same transaction, and only for the
order's first settled attempt. If a sibling attempt on the same order also settles, it is
recorded as `duplicate_settlement`.

## NWC credential and preflight

An NWC code is a [NIP-47 connection string](https://github.com/nostr-protocol/nips/blob/master/47.md#nostr-wallet-connect-uri):

```text
nostr+walletconnect://<wallet pubkey>?relay=wss://…&secret=<64-hex client secret>
```

The `secret` is a Nostr private key that the wallet service minted for this one
connection. It is not the wallet's key. Every call is an encrypted Nostr event
(NIP-04 or NIP-44 v2) sent through the listed relay. The wallet service decides,
per connection, which methods that client key may call.

A **receive-only** connection may call `make_invoice` and `list_transactions`,
which are required. It typically may also call `lookup_invoice` and `get_info`, and receive
`payment_received` notifications. The wallet refuses it `pay_invoice`,
`multi_pay_invoice`, `pay_keysend`, and `multi_pay_keysend`. NIP-47 dropped the `multi_pay_*`
methods in February 2026. Wallets still advertise them, so preflight still treats them as
spend methods.

Whoever holds the secret can do exactly that set of things and nothing more. An attacker
who steals it can mint invoices payable *to* the merchant wallet and read
history. They cannot move a satoshi, because the wallet enforces the refusal.
OpenReceive exposes no send-payment method. The spend-capable override only
widens the damage a leaked secret could do through another NIP-47 client.

### What preflight proves

Preflight reads this connection's own method list from NIP-47 `get_info`. It does not use
the wallet service's kind-13194 info event for this, because that event describes the service
as a whole. The event only supplies the encryption modes. It stands in for the method
list only when a client has no `get_info`, which is logged as
`nwc.info_event.methods_fallback`. Both engines then check, in order:

1. `make_invoice` and `list_transactions` are advertised. Otherwise the result is
   `missing_required_method`.
2. The wallet speaks NIP-04 or NIP-44 v2. Otherwise the result is `unsupported_encryption`.
3. No spend method is advertised. Otherwise the result is `spend_capability_advertised`,
   and the application refuses to start. With the override set, startup
   continues after an `nwc.spend_capability_advertised` error log and a loud
   console warning.

A wallet that cannot answer `get_info` also stops the application from
starting. Node reports this as `ConfigError` (`WALLET_PREFLIGHT_FAILED`)
before `createOpenReceive()` resolves. Framework adapters run preflight
lazily, so the first request awaits it. The Rails engine runs it eagerly in
production. See [Deployment state](deployment-storage.md).

The relay only carries messages. Security never depends on it. A hostile or dead relay
can delay or drop traffic. It cannot forge settlement, because responses are
encrypted between the client key and the wallet pubkey. Settling directly
from a notification assumes the client ties decryption to the connection's
wallet pubkey. The bundled Alby JS SDK does this.

The integrator-facing rules are in [Security](../guides/security.md).
