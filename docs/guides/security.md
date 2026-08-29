# Security

Most of these rules are enforced by the library. The rest — secret handling,
pricing, and any custom repository — are yours to keep.

- Keep the receive-only NWC code and payment-attempt
  [`swap_data`](automated-swaps.md) on the server. A receive-only code
  cannot spend your funds, but anyone who has it can mint invoices against
  your wallet and read payment history. Scan browser bundles
  (`npm run scan:client-bundles`).
- Wallet preflight refuses to start if the NWC connection advertises spend
  methods such as `pay_invoice`. Mint a receive-only code. If the wallet
  cannot and you accept the risk, set
  [`allowSpendCapableWallet: true`](api-reference.md#createopenreceive)
  (Rails: `config.allow_spend_capable_wallet = true`) or
  `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`. The library still logs a loud
  warning.
- Recompute prices from your own order data
  ([`amountFor`](api-reference.md#createhost) /
  [`config.amount_for`](api-reference.md#openreceiveconfigure)). A create
  request carries an order id, never a price. Your
  [`authorize`](api-reference.md#the-authorize-context) policy runs on every
  order-scoped route — [Authorization](authorization.md).
- The attempt row is committed before the invoice is shown. Concurrent
  creates serialize per order. A custom `PaymentRepository` must keep that
  guarantee.
- Accept settlement only from a wallet finality signal (`settled_at` or
  wallet state `settled`). A preimage is never enough.
- Settlement is write-once. `onPaid` / `config.on_paid` runs only for the
  order's first settled attempt, inside the settlement transaction.
- An unpaid attempt is not closed by the server clock. The library waits
  for a successful wallet scan at or after expiry.
- Treat `swap_data` as a provider credential. Never put it in HTTP
  responses or logs. Provider completion alone does not fulfill an order;
  wallet settlement does.

## Why a receive-only NWC code is the only wallet credential

An NWC code is a connection string: a client secret the wallet minted for
**this** connection, plus a relay. The wallet decides which methods that
secret may call.

A receive-only connection can create invoices and list incoming payments.
It cannot pay anyone. If the secret leaks — a compromised server, a `.env`
in git, a log line — an attacker can mint invoices payable *to you* and
read history. They cannot drain the wallet.

OpenReceive has no send-payment path at all. The spend-capable override
above only widens what a leak could do from some other NWC client.

### What preflight proves

On boot (or first request, on Node adapters) OpenReceive asks the wallet
what **this** connection may do:

1. It can `make_invoice` and `list_transactions`.
2. It speaks an encryption mode the library supports.
3. It does not advertise spend methods.

If any check fails, your application does not start. Await the adapter's
`ready` promise in a deploy health check. Tests can
[inject a fake wallet](host-testing.md#inject-a-fake-wallet-client)
and skip NWC entirely.

### What receive-only does not cover

- The code is still a secret. If it leaks, revoke it at the wallet and
  mint a new one. The library redacts it from its own logs.
  `npx openreceive doctor` prints the connection redacted.
- Custody is the wallet service's.
- The relay can delay or drop traffic. It cannot forge settlement —
  responses are encrypted between your client key and the wallet.
- Get a receive-only code from a wallet that issues them:
  <https://openreceive.org/get_a_nwc_code_to_receive_payments>.

## Further reading

- [Deploying OpenReceive](deploying.md)
- [Payment storage](storage.md)
- [Automated swaps](automated-swaps.md) and
  [Lightning Swap Connect](lightning-swap-connect.md)
- [Rate limiting](rate-limiting.md)
- [Authorization](authorization.md)
