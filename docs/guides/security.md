# Security

## OpenReceive follows these security practices

Most of the rules below are enforced by the library itself; the rest — secret
handling, pricing, and any custom repository — are the guarantees your
integration must keep. The sections that follow explain why the wallet
credential is receive-only and what the wallet preflight proves when your
application boots.

- Keep the receive-only NWC code and payment-attempt [`swap_data`](automated-swaps.md)
  server-side. A receive-only NWC code
  [cannot spend your funds](#why-a-receive-only-nwc-code-is-the-only-wallet-credential), but
  you still should not reveal it as it opens a denial-of-service vector on your store (anyone
  holding it can mint invoices against your wallet and read your payment history — see
  [what receive-only does not cover](#what-receive-only-does-not-cover)). Scan browser bundles
  for them ([`npm run scan:client-bundles`](../../tools/validate/scan-client-bundles.mjs)).
- [Wallet preflight](#what-preflight-proves) fails closed when the NWC connection advertises
  spend methods such as [`pay_invoice`][nip47-pay_invoice]: a leaked spend-capable code lets an
  attacker drain the wallet, so OpenReceive refuses to start with one. Mint a receive-only code.
  If the wallet cannot and you accept the risk, the explicit override is
  [`allowSpendCapableWallet: true`](api-reference.md#createopenreceive)
  (Rails: [`config.allow_spend_capable_wallet = true`](api-reference.md#openreceiveconfigure))
  or `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`; OpenReceive still logs a loud warning.
- Recompute checkout prices from your own order/catalog data
  ([`amountFor`](api-reference.md#createhost); Rails
  [`config.amount_for`](api-reference.md#openreceiveconfigure)); reject payer amounts. A
  create request carries an order id, never a price, and your
  [`authorize`](api-reference.md#the-authorize-context) policy runs on every order-scoped
  route ([Authorization and the host](authorization.md)).
- The attempt row commits before the invoice is exposed
  ([`onCheckoutCreated`](api-reference.md#createhost)); the library serializes concurrent
  creates per reference ([Live attempts](storage.md#live-attempts)). Custom
  [`PaymentRepository`](storage.md#escape-hatch) implementations must keep that guarantee
  ([`commitAttempt`](api-reference.md#createsqlpayments)).
- Accept settlement only from [`settled_at`][nwc05-list_transactions] or wallet state
  `settled` ([PaymentCheck status](api-reference.md#paymentcheck-status)); a preimage is never
  final proof. A wallet notification ([NWC-02 `payment_received`][nwc02-payment_received])
  carrying a qualifying finality signal for a known pending attempt settles it directly through
  the same write-once path
  ([`startNotificationListener`](api-reference.md#startnotificationlistener); Rails
  [`OpenReceive.listen_for_notifications!`](api-reference.md#openreceivelisten_for_notifications));
  anything less — no finality signal, an unknown hash, a failed direct settlement — only wakes
  a bounded wallet scan ([`maybeReconcilePayments`](api-reference.md#maybereconcilepayments)).
- Settlement is write-once per attempt and fulfillment ([`onPaid`](api-reference.md#onpaid);
  Rails [`config.on_paid`](api-reference.md#openreceiveconfigure)) runs only for the order's
  first settled attempt, inside the settlement transaction, because delivery is at-least-once.
  A duplicate sibling settlement is recorded (`status_reason = 'duplicate_settlement'`, see the
  [attempt state machine](storage.md#attempt-state-machine)) without fulfilling.
- Closing an unpaid attempt requires a successful wallet scan past expiry plus the 900-second
  grace — never the local clock alone
  ([`reconcileHostPayments`](api-reference.md#reconcilehostpayments),
  [the durable scan gate](deploying.md#the-durable-scan-gate)).
- Treat `swap_data` as a provider credential ([Automated swaps](automated-swaps.md),
  [LSC security requirements](lightning-swap-connect.md#security-requirements)): never
  serialize it into HTTP responses or logs. The public shapes strip it
  ([`PublicSwap`](api-reference.md#publicswap)) and the Rails engine filters it from Active
  Record serialization ([Swap secrets](quickstart-rails.md#swap-secrets)). Optional encryption
  at rest belongs to your framework/database.
- Provider completion alone does not fulfill an order; wallet settlement does
  ([Provider state after settlement](automated-swaps.md#provider-state-after-settlement)).

## Why a receive-only NWC code is the only wallet credential

An NWC code is a [connection string][nip47-uri]:

```text
nostr+walletconnect://<wallet pubkey>?relay=wss://…&secret=<64-hex client secret>
```

The `secret` is a Nostr private key the wallet service minted **for this one
connection** — it is not the wallet's key, and the wallet's signing key never
leaves the wallet service. Every call OpenReceive makes is an encrypted Nostr
event ([NIP-04][nip04] or [NIP-44 v2][nip44]; see [NIP-47
Encryption][nip47-encryption]) sent through the listed relay to the wallet
pubkey, and the wallet service decides, per connection, which [NIP-47
methods][nip47-commands] that client key may invoke. That permission set is
the whole security model:

- A **receive-only** connection may call [`make_invoice`][nip47-make_invoice]
  and [`list_transactions`][nwc05-list_transactions] (the two methods
  OpenReceive requires), typically plus [`lookup_invoice`][nip47-lookup_invoice],
  [`get_info`][nip47-get_info], and [`payment_received`][nwc02-payment_received]
  notifications. It is refused [`pay_invoice`][nip47-pay_invoice],
  [`multi_pay_invoice`][nip47-legacy-multi_pay_invoice],
  [`pay_keysend`][nwc04-pay_keysend], and
  [`multi_pay_keysend`][nip47-legacy-multi_pay_keysend]. (The `multi_pay_*`
  methods were dropped from NIP-47 in February 2026 — the links go to the last
  revision that defined them — but wallets still advertise them, so preflight
  still treats them as spend methods.)
- Whoever holds the secret can do exactly what that set allows and nothing
  more. An attacker who takes it — a compromised server, a leaked `.env`, a
  log line, a screenshot — can mint invoices payable **to your wallet** and
  read your transaction history; they cannot move a satoshi, because the
  refusal lives at the wallet, with the party holding the funds, not in
  application code they now control.

This is why OpenReceive has no spend path at all: neither engine exposes a
send-payment method (the [wallet client](api-reference.md#wallet-client)
surface is the whole list), so even the spend-capable override
[below](#what-preflight-proves) does not add one. The override only widens
the damage a leak could do from another NIP-47 client; it never changes what
OpenReceive can do.

### What preflight proves

When your application boots, OpenReceive reads the connection's **own**
method list from NIP-47 [`get_info`][nip47-get_info] — what _this_
connection may call — not the wallet service's kind-13194
[info event][nip47-info-event], which advertises the service at large (a
service that also serves spend-capable apps still hands out receive-only
connections). The event only supplies
[encryption modes][nip47-encryption], and stands in for the method list when a
client has no `get_info` (logged as `nwc.info_event.methods_fallback`). Both
engines then check, in order:

1. [`make_invoice`][nip47-make_invoice] and
   [`list_transactions`][nwc05-list_transactions] are advertised — otherwise
   `missing_required_method`.
2. The wallet speaks [NIP-04][nip04] or [NIP-44 v2][nip44] — otherwise
   `unsupported_encryption`.
3. No spend method is advertised — otherwise `spend_capability_advertised`,
   and your application refuses to start. With the override set, startup
   continues after an `nwc.spend_capability_advertised` error log and a loud
   console warning.

A wallet that cannot answer `get_info` also stops your application from
starting rather than deferring the failure to a customer's first checkout. Node surfaces all of this as
`ConfigError` (`WALLET_PREFLIGHT_FAILED`) before
[`createOpenReceive()`](api-reference.md#createopenreceive) resolves — the
[framework adapters](api-reference.md#framework-adapters) run preflight lazily
(the first request awaits it), so await it in a deploy health check: the
Express middleware and the Next handler expose a `ready` promise, and on
Fastify `await fastify.ready()` covers it (the plugin exposes no `ready` of its
own). The Rails engine runs the same preflight eagerly in production
([When your application boots](deploying.md#when-your-application-boots)).
Tests can [inject a fake wallet client](host-testing.md#inject-a-fake-wallet-client)
to skip NWC and preflight entirely.

### What receive-only does not cover

- The code is still a secret. It exposes your payment history and lets anyone
  mint invoices against your wallet, so keep it in server-side environment
  only; if it leaks, revoke the connection at the wallet service and mint a new
  one. The repository's [`npm run scan:secrets`](../../tools/validate/scan-secrets.mjs)
  and [`scan:client-bundles`](../../tools/validate/scan-client-bundles.mjs)
  gates look for `nostr+walletconnect://…secret=` and `NWC_URI` markers in
  tracked files and built browser bundles ([test command
  map](../internal/test-command-map.md)); the library redacts the secret from
  every log line and error it emits, and
  [`npx openreceive doctor`](api-reference.md#openreceive-doctor) prints the
  parsed connection redacted.
- Custody is the wallet service's.
- The relay is a transport, not a trust anchor
  ([using a dedicated relay][nip47-relay]). A hostile or dead relay can delay
  or drop traffic; it cannot forge settlement, because responses are
  [encrypted][nip47-encryption] between the client key and the wallet pubkey,
  and direct settlement from a notification
  ([`startNotificationListener`](api-reference.md#startnotificationlistener))
  assumes the client binds decryption to the connection's wallet pubkey (the
  bundled [Alby JS SDK][alby-sdk] does).
- Get a receive-only code from a wallet that issues them:
  <https://openreceive.org/get_a_nwc_code_to_receive_payments>.

## Further reading

Specifications:

- [NIP-47 Nostr Wallet Connect][nip47] — the core protocol; a verbatim copy is
  vendored at [docs/reference/nip-47.txt](../reference/nip-47.txt) for offline
  reading.
- [NWC extension specs][nwc-repo]: [NWC-02 Notifications][nwc02],
  [NWC-04 Keysend Payments][nwc04], [NWC-05 Transaction History][nwc05].
- [NIP-04][nip04] and [NIP-44][nip44] — the two encryption schemes preflight
  accepts.

In these docs:

- [Deploying OpenReceive](deploying.md) — scan gate, worker topology, what
  happens when your application boots, operational monitoring.
- [Payment storage](storage.md) — schema, attempt state machine, the
  `PaymentRepository` escape hatch.
- [Automated swaps](automated-swaps.md) and
  [Lightning Swap Connect](lightning-swap-connect.md) — `swap_data` and
  provider credentials.
- [Rate limiting](rate-limiting.md) — the opt-in per-IP invoice cap.
- [Settlement reconciliation](../internal/settlement-sweeps.md) and
  [Swap operations](../internal/swap-operations.md#refund-safety) — internals.

[nip47]: https://github.com/nostr-protocol/nips/blob/master/47.md
[nip47-uri]: https://github.com/nostr-protocol/nips/blob/master/47.md#nostr-wallet-connect-uri
[nip47-commands]: https://github.com/nostr-protocol/nips/blob/master/47.md#commands
[nip47-encryption]: https://github.com/nostr-protocol/nips/blob/master/47.md#encryption
[nip47-info-event]: https://github.com/nostr-protocol/nips/blob/master/47.md#info-event
[nip47-relay]: https://github.com/nostr-protocol/nips/blob/master/47.md#using-a-dedicated-relay
[nip47-pay_invoice]: https://github.com/nostr-protocol/nips/blob/master/47.md#pay_invoice
[nip47-make_invoice]: https://github.com/nostr-protocol/nips/blob/master/47.md#make_invoice
[nip47-lookup_invoice]: https://github.com/nostr-protocol/nips/blob/master/47.md#lookup_invoice
[nip47-get_info]: https://github.com/nostr-protocol/nips/blob/master/47.md#get_info
[nip47-legacy-multi_pay_invoice]: https://github.com/nostr-protocol/nips/blob/01838f302ddf639b2cfc1bfbe6232401e82eac58/47.md#multi_pay_invoice
[nip47-legacy-multi_pay_keysend]: https://github.com/nostr-protocol/nips/blob/01838f302ddf639b2cfc1bfbe6232401e82eac58/47.md#multi_pay_keysend
[nwc-repo]: https://github.com/nostr-wallet-connect/nwc
[nwc02]: https://github.com/nostr-wallet-connect/nwc/blob/main/02.md
[nwc02-payment_received]: https://github.com/nostr-wallet-connect/nwc/blob/main/02.md#payment_received
[nwc04]: https://github.com/nostr-wallet-connect/nwc/blob/main/04.md
[nwc04-pay_keysend]: https://github.com/nostr-wallet-connect/nwc/blob/main/04.md#pay_keysend
[nwc05]: https://github.com/nostr-wallet-connect/nwc/blob/main/05.md
[nwc05-list_transactions]: https://github.com/nostr-wallet-connect/nwc/blob/main/05.md#list_transactions
[nip04]: https://github.com/nostr-protocol/nips/blob/master/04.md
[nip44]: https://github.com/nostr-protocol/nips/blob/master/44.md
[alby-sdk]: https://github.com/getAlby/js-sdk
