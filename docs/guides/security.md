# Security

- Keep receive-only NWC and payment-attempt `swap_data` server-side. Scan browser bundles for them.
- Wallet preflight fails closed when the NWC connection advertises spend methods such as
  `pay_invoice`: a leaked spend-capable code lets an attacker drain the wallet, so OpenReceive
  refuses to boot with one. Mint a receive-only code. If the wallet cannot and you accept the
  risk, the explicit override is `allowSpendCapableWallet: true`
  (Rails: `config.allow_spend_capable_wallet = true`) or
  `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`; OpenReceive still logs a loud warning.
- Recompute checkout prices from your own order/catalog data; reject payer amounts.
- The attempt row commits before the invoice is exposed; the library serializes concurrent
  creates per order. Custom `OpenReceivePaymentRepository` implementations must keep that
  guarantee.
- Accept settlement only from `settled_at` or wallet state `settled`; a preimage is never final
  proof. A wallet notification carrying a qualifying finality signal for a known pending attempt
  settles it directly through the same write-once path; anything less — no finality signal, an
  unknown hash, a failed direct settlement — only wakes a bounded wallet scan.
- Settlement is write-once per attempt and fulfillment runs only for the order's first settled
  attempt, inside the settlement transaction, because delivery is at-least-once. A duplicate
  sibling settlement is recorded (`status_reason = 'duplicate_settlement'`) without fulfilling.
- Closing an unpaid attempt requires a successful wallet scan past expiry plus the 900-second
  grace — never the local clock alone.
- Treat `swap_data` as a provider credential: never serialize it into HTTP responses or logs.
  Optional encryption at rest belongs to your framework/database.
- Provider completion alone does not fulfill an order; wallet settlement does.

## Why a receive-only NWC code is the only wallet credential

An NWC code is a connection string:

```text
nostr+walletconnect://<wallet pubkey>?relay=wss://…&secret=<64-hex client secret>
```

The `secret` is a Nostr private key the wallet service minted **for this one
connection** — it is not the wallet's key, and the wallet's signing key never
leaves the wallet service. Every call OpenReceive makes is an encrypted Nostr
event (NIP-04 or NIP-44 v2) sent through the listed relay to the wallet pubkey,
and the wallet service decides, per connection, which NIP-47 methods that
client key may invoke. That permission set is the whole security model:

- A **receive-only** connection may call `make_invoice` and `list_transactions`
  (the two methods OpenReceive requires), typically plus `lookup_invoice`,
  `get_info`, and `payment_received` notifications. It is refused
  `pay_invoice`, `multi_pay_invoice`, `pay_keysend`, and `multi_pay_keysend`.
- Whoever holds the secret can do exactly what that set allows and nothing
  more. An attacker who takes it — a compromised server, a leaked `.env`, a
  log line, a screenshot — can mint invoices payable **to your wallet** and
  read your transaction history; they cannot move a satoshi, because the
  refusal lives at the wallet, with the party holding the funds, not in
  application code they now control.

This is why OpenReceive has no spend path at all: neither engine exposes a
send-payment method, so even the spend-capable override below does not add
one. The override only widens the damage a leak could do from another NIP-47
client; it never changes what OpenReceive can do.

### What preflight proves

Boot reads the connection's **own** method list from NIP-47 `get_info` — what
_this_ connection may call — not the wallet service's kind-13194 info event,
which advertises the service at large (a service that also serves
spend-capable apps still hands out receive-only connections). The event only
supplies encryption modes, and stands in for the method list when a client has
no `get_info` (logged as `nwc.info_event.methods_fallback`). Both engines then
check, in order:

1. `make_invoice` and `list_transactions` are advertised — otherwise
   `missing_required_method`.
2. The wallet speaks NIP-04 or NIP-44 v2 — otherwise `unsupported_encryption`.
3. No spend method is advertised — otherwise `spend_capability_advertised`,
   and boot is refused. With the override set, boot continues after an
   `nwc.spend_capability_advertised` error log and a loud console warning.

A wallet that cannot answer `get_info` also fails boot rather than deferring
the failure to a customer's first checkout. Node surfaces all of this as
`OpenReceiveConfigError` (`WALLET_PREFLIGHT_FAILED`) before
[`createOpenReceive()`](api-reference.md#createopenreceive) resolves; the Rails
engine runs the same preflight eagerly in production
([Deploying](deploying.md#boot-behavior)).

### What receive-only does not cover

- The code is still a secret. It exposes your payment history and lets anyone
  mint invoices against your wallet, so keep it in server-side environment
  only; if it leaks, revoke the connection at the wallet service and mint a new
  one. The repository's `npm run scan:secrets` and `scan:client-bundles`
  gates look for `nostr+walletconnect://…secret=` and `NWC_URI` markers in
  tracked files and built browser bundles; the library redacts the secret from
  every log line and error it emits.
- Custody is the wallet service's.
- The relay is a transport, not a trust anchor. A hostile or dead relay can
  delay or drop traffic; it cannot forge settlement, because responses are
  encrypted between the client key and the wallet pubkey, and direct
  settlement from a notification assumes the client binds decryption to the
  connection's wallet pubkey (the bundled SDK does).
- Get a receive-only code from a wallet that issues them:
  <https://openreceive.org/get_a_nwc_code_to_receive_payments>.
