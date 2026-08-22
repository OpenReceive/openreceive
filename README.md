# OpenReceive

Accept payments on your website or app that no one can block, reverse, or freeze.

<img src="packages/js/browser/src/assets/icons/btc.svg" alt="Bitcoin" width="56">

**Bitcoin by default.** Bitcoin is the most neutral settlement currency on the
internet. Your server issues an invoice from a wallet you already control. The payer settles it, and your server
approves delivery of the purchase.

**Deposit-only by design.** Funds move in one direction — toward you.
OpenReceive never takes custody of your money and never holds a key that can
spend it, so your inbound funds are never at risk. You can use [any backing NWC service](https://openreceive.org/get_a_nwc_code_to_receive_payments) to hold your funds.

**Optionally Swap In Payments From Other Currencies:**

<img src="packages/js/browser/src/assets/icons/usdt.svg" alt="USDT" width="36">
<img src="packages/js/browser/src/assets/icons/usdc.svg" alt="USDC" width="36">
<img src="packages/js/browser/src/assets/icons/eth.svg" alt="Ethereum" width="36">
<img src="packages/js/browser/src/assets/icons/sol.svg" alt="Solana" width="36">

Not every customer holds Bitcoin. Configure any swap provider that implements
the [FixedFloat / Lightning-Swap API](https://lightning-swap.com/api_docs), and
your customers can pay in USDT, USDC, ETH, SOL, and more — each is instantly converted into
Bitcoin on the way in.

OpenReceive is not a bank, exchange, wallet, broker, custodian, or payment
processor. It does not transmit money or hold customer funds. It helps your
backend create invoices and verify settlement — nothing more.

## Quickstart

Pick your stack:

| Stack         | Quickstart                                          |
| ------------- | --------------------------------------------------- |
| Node.js       | [Node quickstart](docs/guides/quickstart-node.md)   |
| Ruby on Rails | [Rails quickstart](docs/guides/quickstart-rails.md) |
| BTCPay Server | Coming soon                                         |

Each one is the same loop: your server owns the price and the order, the payer
gets a Lightning invoice, and your `onPaid` hook runs once inside the settlement
transaction.

## What can customers pay with?

Every checkout ends at the same settlement primitive: a Lightning invoice paid
into the merchant wallet.

- **Bitcoin Lightning** — direct BOLT11 payment with no swap provider.
- **USDT** — automated pay-in routes on Tron, Solana, and Ethereum.
- **USDC** — automated pay-in routes on Solana and Ethereum.
- **SOL** — automated pay-in on Solana.
- **ETH** — automated pay-in on Ethereum.

Swap options appear only when a compatible provider is configured and returns
a usable quote. Actual availability, minimums, fees, liquidity, and regional
access belong to that provider; OpenReceive never promises that every route is
available for every payer.

Products can be priced directly in BTC or sats, or in a configured fiat
currency. The built-in price-feed data supports:

```text
USD, AED, ARS, AUD, BDT, BHD, BMD, BRL, CAD, CHF, CLP, CNY, CZK, DKK,
EUR, GBP, GEL, HKD, HUF, IDR, ILS, INR, JPY, KRW, KWD, LKR, MMK, MXN,
MYR, NGN, NOK, NZD, PHP, PKR, PLN, RUB, SAR, SEK, SGD, THB, TRY, TWD,
UAH, VEF, VND, ZAR
```

Fiat is a pricing input, not a settlement asset. OpenReceive converts the exact
decimal order price to sats when creating the invoice; public payment payloads
use `amount_msats`.

## Design

OpenReceive hinges on three ideas:

- **One receive primitive.** BOLT11 is widely recognized across wallets,
  exchanges, and services. Every payment route converges on one fast,
  interoperable Lightning invoice.
- **Your wallet, your funds.** OpenReceive uses receive-only NWC methods to
  create and inspect invoices. Receive-only NWC codes never belong in browser
  code, mobile apps, logs, screenshots, documentation examples, or demo assets.
- **Your app owns business state.** Your application owns orders; the library
  owns the `openreceive_payments` rows (they live in your database) — see
  [Payment storage](docs/guides/storage.md). OpenReceive never owns orders,
  users, prices, or fulfillment, and never requires a separate database,
  Redis, or migration runner: you pass a database handle, and the library
  owns the schema, locking, settlement write-once, and reconciliation.

## How it fits into your app

OpenReceive is three server objects plus an optional browser package. Each one
talks to a different side of your app, and each has an obvious home:

| Piece                        | You build it with                                                                                                                                                                                                                                   | It talks to                                                                 | It lives                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| **Wallet client**            | [`createOpenReceive()`][api-createopenreceive]                                                                                                                                                                             | **your wallet** — mints invoices, reads settlement, holds the NWC code      | server-only, one per process                     |
| **Order bridge**             | [`createOpenReceiveHost()`][api-createopenreceivehost]                                                                                                                                                                     | **your database** — your order hooks, plus the `openreceive_payments` table | server-only, next to your models                 |
| **HTTP routes**              | [`openReceiveExpress()`][api-express] (or [Fastify][api-fastify] / [Next][api-next] / [Rails](docs/guides/quickstart-rails.md)) | **the browser** — the endpoints the checkout UI calls                       | mounted on your app by default at `/openreceive` |
| **Checkout UI** *(optional)* | [`@openreceive/react`][api-browser] (or vue/svelte/angular/elements)                                                                                                                                                | **the HTTP routes above** — creates the checkout, polls until paid          | your browser bundle                              |

Only that last row is genuinely optional. Take the drop-in components, build
your own on the semver-stable `@openreceive/browser/headless` engine, or skip
our browser packages altogether and call the routes yourself — the server side
is identical either way. See
[Headless checkout](docs/guides/headless-checkout.md).

The three server pieces:

```ts
import { openReceiveExpress } from "@openreceive/express";
import { createOpenReceiveHost } from "@openreceive/http";
import { createOpenReceive } from "@openreceive/node";

// 1. The wallet client. Reads NWC_URI; never let this reach client code.
const service = await createOpenReceive();

// 2. The order bridge: your database and your order model.
const host = createOpenReceiveHost({
  db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
  loadOrder: (orderId) => orders.find(orderId),
  // The authoritative price for that order — never taken from payer input.
  // OpenReceive converts this exact decimal into the invoice amount.
  amountForOrder: (order) => ({
    currency: order.currency,
    value: order.total.toString(),
  }),
  onPaid: async ({ orderId, query }) => {
    // Runs inside the settlement transaction, only for the order's first
    // settled attempt. Update the order or insert an outbox row here.
    await query("UPDATE orders SET state = 'paid' WHERE id = ?", [orderId]);
  },
});

// 3. The HTTP routes. `authorize` is your own access check (below).
app.use(openReceiveExpress({ service, host, authorize }));
```

You usually write none of that. Passing the hooks straight to the adapter —
`openReceiveExpress({ nwc, db, loadOrder, amountForOrder, onPaid, authorize })` —
is the same three server objects in one call, and it is what the
[quickstart](docs/guides/quickstart-node.md) does. Name them yourself only when
two mounts share one wallet connection, when you supply a custom payments
repository, or when a test needs the order bridge without an HTTP server.

In code those two server objects are conventionally named `service` and `host`
— the parameter names every adapter expects — which is why you will see them
spelled that way throughout the guides and the API reference.

### What the order bridge owns

Keep your order model unchanged. The order bridge owns one
`openreceive_payments` table inside your existing database — you run its
migration through your own workflow ([`npx openreceive scaffold payments`][api-scaffold]
emits it for your ORM) — along with the schema, per-order commit locking,
write-once settlement, and the reconciliation state machine.

`order_id` is the only link back to your app, and it is deliberately a loose
one: opaque `TEXT` with no foreign key. OpenReceive never reads, writes, locks,
or joins your orders table — it does not know that table's name or its key
type. It only hands the string back to [`loadOrder`, `amountForOrder`, and
`onPaid`][api-createopenreceivehost], so a deleted or renamed order can never
stall settlement.

Each row is one invoice or swap attempt with a status
(`pending | settled | expired | failed | attention`) and a `status_reason`. These are
row statuses; `attention` is an operator state that reads as `pending` on the wire. A
row is committed before payer instructions are exposed; `payment_hash` is
globally unique; a settled row is never overwritten; a duplicate sibling
settlement is recorded with `status_reason = 'duplicate_settlement'` and never
fulfills twice. An order has one live payment session with at most one live
attempt per rail/asset so a payer can switch between Lightning and swap assets
— your app never sees that vocabulary; an order is simply unpaid or paid.
`swap_data` holds provider credentials and must never reach browser code or
logs.

Implementing a custom [`OpenReceivePaymentRepository`][api-sqlpayments] is the
documented advanced escape hatch, not the quickstart. See
[Payment storage](docs/guides/storage.md).


### What the wallet client needs

[`createOpenReceive()`][api-createopenreceive] reads the receive-only wallet
connection from `NWC_URI`. Optional swap connections come from
`LSC_URI_PRIMARY` and `LSC_URI_BACKUP`.
These are the only OpenReceive secret environment variables.
The library does not load `.env` itself; your application's entry point or deployment
platform supplies the environment. Pass `nwc` explicitly only for an
intentional runtime override, such as an isolated test.

Boot preflight fails closed when the wallet advertises spend methods such as
`pay_invoice`; the explicit override is `allowSpendCapableWallet: true` or
`OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`. See
[Security](docs/guides/security.md).


### Writing your own checkout route

Most applications should not do this. Mounting the adapter gives you the routes *and*
lets the shipped checkout components (`@openreceive/react` and friends) work
against them with no glue — hand-writing the endpoint opts you out of both, UI
included. Reach for it when you need a flow the routes do not offer. You then
drive the same `service` and `host` objects yourself, and the order of the
three steps matters:

```ts
// `service` and `host` are the wallet client and order bridge from above.
// The route around them is yours: your router, your auth, your response.
app.post("/orders/:id/checkout", async (req, res) => {
  const order = await orders.find(req.params.id);
  const user = await sessions.currentUser(req);
  if (!order || !(await orders.viewerMay(user, order.id, "pay"))) {
    return res.sendStatus(403);
  }

  // 1. Mint the invoice. This is a pure wallet call: it persists nothing.
  const checkout = await service.createCheckout({
    orderId: order.id,
    amount: { currency: "USD", value: order.total.toString() },
  });

  // 2. Commit the attempt row, so reconciliation knows this invoice exists.
  await host.onCheckoutCreated({
    orderId: order.id,
    paymentHash: checkout.paymentHash,
    checkout,
  });

  // 3. Only now is it safe to hand the payer their instructions. Since this
  //    route is yours, so is the payload shape — see the note after the example.
  res.json({
    bolt11: checkout.bolt11, // the invoice string — render it as a QR code
    amount_msats: checkout.amountMsats, // what the wallet must receive to settle
    expires_at: checkout.expiresAt, // unix seconds; the QR is dead after this
    payment_hash: checkout.paymentHash, // the selector for later status checks
  });
});
```

Two responsibilities move to you on this path:

- **Authorization.** Normally you hand an `authorize` function to the adapter
  and it runs on every request. There is no adapter here, so nothing calls it:
  your handler has to check permissions itself, which is what the `viewerMay`
  guard above is doing. Leave it out and anyone who can guess an order id can
  mint an invoice against that order.
- **Ordering.** Step 1 mints a real, payable invoice at your wallet but writes
  nothing down; step 2 is what records it. Return — or throw — in between, and
  a payer can pay an invoice your database has no row for. Reconciliation only
  scans rows, so that payment settles nothing and `onPaid` never runs.

**A route like this does not serve OpenReceive's `<Checkout>` component.** The
four fields above are just what a payment page tends to need — they are not a
contract. Our React/Vue/Svelte/Angular components post to `{prefix}/checkouts`
and expect the documented `CreateCheckoutResponse`:

```jsonc
{
  "checkout": {
    // all six required; no additional properties allowed
    "order_id": "...",
    "payment_hash": "...",
    "bolt11": "...",
    "amount_msats": 1250000,
    "created_at": 1755800000,
    "expires_at": 1755800600,
    "fiat_quote": null, // present when the order was priced in fiat
  },
}
```

That is the opt-out named at the top of this section: serve a shape of your own
and you supply the payment UI too. Serving `CreateCheckoutResponse` verbatim at
`{prefix}/checkouts` keeps our components working — but that is exactly what
mounting the adapter already does, for free.

Either way, every field on `checkout` is payer-safe, so a UI of your own can
take whatever shape it likes. It then polls for settlement — OpenReceive's
`POST …/payments/check`, or your own route over
[`service.checkPayment`][api-checkpayment] — until the order flips to paid.


### Who checks the wallet, and when

The wallet client's `checkPayment({ paymentHash, createdAt })` is a pure wallet
read: it verifies one known attempt with bounded `list_transactions` scans,
and reconciliation stays batched — never one lookup per invoice. The mounted
HTTP route `POST …/payments/check` is a different thing: it never runs its own
per-invoice wallet walk, serving the requested hash from the request's gated
reconcile pass (or from the stored attempt row when another worker holds the
gate). Settlement is opportunistic by default: every mounted payment route
runs one gated pass over `pending` attempts — the durable `openreceive_meta`
gate collapses all instances to one wallet scan per interval, and `GET …/rates`
never triggers a scan — delivering verified settlements at least once. No
background process required.


## Ship the routes, keep your auth

Browser integrations mount `@openreceive/http` through Express, Fastify, Next,
or Rails. OpenReceive never inspects your session. The order bridge resolves
authoritative prices, selects committed attempts, and persists new ones; your
application supplies authorization.

A create request supplies an order ID, never its own price. The order bridge
resolves the authoritative amount from that order.

That leaves one thing for you to write — the [`authorize`][api-authorize] callback the routes
call on every request. An order ID identifies a row, but possession of that ID
is not proof that the caller owns the order:

```ts
authorize: async ({ action, request, resource }) =>
  orders.authorize({ request, orderId: resource.orderId, action }),
```

The attempt row commits before the payer receives the invoice. A refused
commit (already-paid order, competing live attempt) gets a [`409` response][api-errors] — an
infrastructure failure a retryable `503` — with no payer instructions either
way. Rails applications mount the engine and retain their own authentication
and `current_user` logic. JSON checkout routes skip Rails form CSRF; your
`authorize` is the auth boundary.


## Settlement and swaps

Settlement detection is poll-based: reconciliation scans the wallet with
bounded `list_transactions` reads over the pending attempts. Optional NWC-02
notification workers (Node [`startOpenReceiveNotificationWorker`][api-notifworker], Rails
[`rake openreceive:notifications`][api-rake-notifications]) carry authenticated
wallet data: a settled `payment_received` payload settles the matching pending
attempt directly over
that channel, under the same finality rule as scans — `settled_at` or a wallet
transaction state of `settled`, never a preimage alone. Anything less (a
payload without a finality signal, or an unknown payment hash) only wakes a
bounded scan, and the worker's own periodic pass remains the safety net for
notifications missed while it was down. Direct settlement assumes the NWC client binds
notification decryption to the connection's wallet pubkey (the bundled SDK
does). Closing an unpaid attempt requires a successful
wallet scan at or after its expiry plus a 900-second grace
(`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS`, a constant exported by
`@openreceive/http` — not an environment variable) — a local clock alone never closes
a row, because a payment could have settled while the application was offline.
OpenReceive also requires the wallet to honor the requested invoice expiry:
checkout creation fails closed (beyond a small tolerance) when a wallet mints
an invoice with a different expiry window.

Swap recovery is independent of wallet settlement. The payment hash proves
that the merchant wallet was paid. The payment attempt's server-only `swap_data`
contains the provider workflow details needed to query an unresolved swap
after a process restart. OpenReceive never exposes that field through its HTTP
routes. Refund calls go through your `authorize` and refresh provider state immediately
before acting.

Provider completion by itself never fulfills an order. The receiving wallet's
settled transaction remains authoritative.


## Repository map

- `spec/` is the source of truth for schemas, shared data, test vectors, and the
  shipped HTTP contract.
- `packages/js/` contains the core contracts, Node NWC wallet client, HTTP routes,
  Express/Fastify/Next adapters, browser helpers, provider data, testkit,
  elements, and React/Vue/Svelte/Angular packages.
- `packages/ruby/` contains the dependency-free core, the Service and Rack app,
  and the mountable Rails engine—a second settlement implementation checked
  against shared vectors.
- `examples/hello-fruit/server/` contains Express, static HTML, Next.js, and
  Rails demos. Demo order models are ordinary application code.
- `tools/` contains validation, conformance, package-smoke, documentation, and
  live-wallet helpers.

Version numbers are deliberately independent per domain: the package/workspace
release is `0.1.1`, the OpenAPI HTTP contract is `0.4.0`, and the AsyncAPI event
contract is `0.2.0`; each is versioned inside its own file and none of them
tracks the others.

## Run a demo

The Hello Fruit demos let you add products to a cart, create an order, and
pay its live Lightning invoice:

```sh
npm run demo node      # Express + React/Vue/Svelte/Angular http://localhost:3000
npm run demo static    # Static HTML + small API             http://localhost:3001
npm run demo nextjs    # Next.js fullstack                   http://localhost:3002
npm run demo rails     # Rails + host Postgres               http://localhost:3003
```

Each command creates a root `.env` from `.env.example` if missing, validates
`NWC_URI`, and runs that demo's Docker Compose stack. Set a valid receive-only
NWC URI from a compatible wallet before checkout creation. Optional automated
swaps use `LSC_URI_PRIMARY` and `LSC_URI_BACKUP`; provider
credentials never reach the browser.

Arguments after `--` are forwarded to `docker compose up`, for example:

```sh
npm run demo node -- -d
```

## Development status

The full gate keeps schemas, vectors, generated contracts, Node and Ruby
behavior, package artifacts, demos, secret scans, release metadata, deployment
templates, and documentation aligned:

```sh
npm run test:ci:core   # fast JS/package gate
npm run test:ci        # full deterministic gate, including Ruby and demos
npm test               # contracts and secret-safety checks
npm run test:live      # live wallet smoke (Node + Ruby); separate from test:ci
```

## Product boundary

OpenReceive creates a Lightning invoice and can return payer-side guidance for
direct Lightning or configured swap routes. Provider routes are suggestions,
not payment guarantees. The payer chooses and uses third-party services under
those services' terms.

Browser, mobile, and static frontend code never receive the merchant's
receive-only NWC code. A live checkout always needs a backend controlled by the
merchant application.

## Documentation

Start with the [developer guides](docs/guides/README.md):

- [What is OpenReceive?](docs/guides/what-is.md)
- [Node quickstart](docs/guides/quickstart-node.md)
- [Node ORM recipes](docs/guides/node-orms.md)
- [Rails quickstart](docs/guides/quickstart-rails.md)
- [Frontend checkout](docs/guides/frontend-checkout.md)
- [Headless checkout](docs/guides/headless-checkout.md)
- [Price feeds](docs/guides/price-feeds.md)
- [Automated swaps](docs/guides/automated-swaps.md)
- [Lightning Swap Connect](docs/guides/lightning-swap-connect.md)
- [Provider registry](docs/guides/provider-registry.md)
- [Authorization](docs/guides/authorization.md)
- [Rate limiting](docs/guides/rate-limiting.md)
- [Payment storage](docs/guides/storage.md)
- [Deploying OpenReceive](docs/guides/deploying.md)
- [Testing your OpenReceive integration](docs/guides/host-testing.md)
- [Security](docs/guides/security.md)
- [API reference](docs/guides/api-reference.md)
- [React + Material UI recipe](docs/recipes/react-material-ui.md)
- [Normative HTTP contract](spec/openapi/openreceive-http.v1.yaml)
- [Contributor and operator docs](docs/internal/README.md)

[api-authorize]: docs/guides/api-reference.md#the-authorize-context
[api-browser]: docs/guides/api-reference.md#browser--react
[api-checkpayment]: docs/guides/api-reference.md#servicecheckpayment
[api-createopenreceive]: docs/guides/api-reference.md#createopenreceive
[api-createopenreceivehost]: docs/guides/api-reference.md#createopenreceivehost
[api-errors]: docs/guides/api-reference.md#errors
[api-express]: docs/guides/api-reference.md#openreceiveexpress
[api-fastify]: docs/guides/api-reference.md#openreceivefastify
[api-next]: docs/guides/api-reference.md#openreceivenexthandlers
[api-notifworker]: docs/guides/api-reference.md#startopenreceivenotificationworker
[api-rake-notifications]: docs/guides/api-reference.md#rake-openreceivenotifications
[api-scaffold]: docs/guides/api-reference.md#openreceive-scaffold-payments
[api-sqlpayments]: docs/guides/api-reference.md#createopenreceivesqlpayments
