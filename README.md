# OpenReceive

Accept Bitcoin payments on your website or app, straight into a wallet you control.

<img src="packages/js/browser/src/assets/icons/btc.svg" alt="Bitcoin" width="56">

**Bitcoin by default.** Bitcoin is the most neutral settlement currency on the
internet. Your server issues an invoice from a wallet you already control. The payer settles it, and your server
approves delivery of the purchase.

**Deposit-only by design.** OpenReceive exposes no payment-sending API and
never holds a key: it connects with a receive-only NWC code, and boot fails
closed when the code can spend. Custody, freezing, and reversal are properties
of the [NWC service](https://openreceive.org/get_a_nwc_code_to_receive_payments)
and swap provider you choose — not of this library.

**Optionally swap in other currencies.** Not every customer holds Bitcoin.
Configure any swap provider that implements the
[FixedFloat / Lightning-Swap API](https://lightning-swap.com/api_docs) and
checkout offers these pay-in routes, each converted into Bitcoin on the way in:

| Pay with                                                                                                  | On network                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="packages/js/browser/src/assets/icons/usdt.svg" alt="USDT" width="28"> &nbsp;**USDT** (Tether)   | <img src="packages/js/browser/src/assets/icons/trx.svg" alt="Tron" width="18"> Tron &nbsp;&nbsp; <img src="packages/js/browser/src/assets/icons/sol.svg" alt="Solana" width="18"> Solana &nbsp;&nbsp; <img src="packages/js/browser/src/assets/icons/eth.svg" alt="Ethereum" width="18"> Ethereum |
| <img src="packages/js/browser/src/assets/icons/usdc.svg" alt="USDC" width="28"> &nbsp;**USDC** (USD Coin) | <img src="packages/js/browser/src/assets/icons/sol.svg" alt="Solana" width="18"> Solana &nbsp;&nbsp; <img src="packages/js/browser/src/assets/icons/eth.svg" alt="Ethereum" width="18"> Ethereum                                                                                                  |
| <img src="packages/js/browser/src/assets/icons/sol.svg" alt="SOL" width="28"> &nbsp;**SOL** (Solana)      | <img src="packages/js/browser/src/assets/icons/sol.svg" alt="Solana" width="18"> Solana                                                                                                                                                                                                           |
| <img src="packages/js/browser/src/assets/icons/eth.svg" alt="ETH" width="28"> &nbsp;**ETH** (Ether)       | <img src="packages/js/browser/src/assets/icons/eth.svg" alt="Ethereum" width="18"> Ethereum                                                                                                                                                                                                       |

OpenReceive does not transmit money or hold customer funds. It helps your
backend create invoices and verify settlement — nothing more.

> **Terminology.** **NWC** (Nostr Wallet Connect, specified by **NIP-47**) is the
> protocol a Lightning wallet exposes so an application can ask it to create
> invoices and list payments — a receive-only NWC connection string is the only
> wallet credential OpenReceive needs. A **BOLT11** invoice is the standard
> Lightning payment request string payers scan or paste. Amounts are counted in
> **sats** (satoshis, 1/100,000,000 BTC) and **msats** (millisatoshis, 1/1000 sat
> — the unit on the wire). A **rail** is one way to pay a checkout: Lightning
> directly, or a **swap** (the payer sends another asset, e.g. USDT, and a swap
> provider pays the Lightning invoice).

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

## Design

- **Paranoid security defaults.**
  1. An attacker who gains control of your server has no way to spend your funds:
     all your server holds is a receive-only NWC code.
  2. Every payment settles as a private, immutable Bitcoin Lightning payment, swapped from other
     currencies as necessary. No funds are held in centrally-controlled, censorable currencies like SOL, USDT, OR USDC.
- **Your app owns business state.** Your application owns orders; the library
  owns the `openreceive_payments` rows (they live in your database) — see
  [Payment storage](docs/guides/storage.md). OpenReceive never owns orders,
  users, prices, or fulfillment, and never requires a separate database,
  Redis, or migration runner: you pass a database handle, and the library
  owns the schema, locking, settlement write-once, and reconciliation.

## How it fits into your app

OpenReceive is three server objects plus an optional browser package. Each one
talks to a different side of your app, and each has an obvious home:

| Piece                        | You build it with                                                                                                               | It talks to                                                                 | It lives                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| **Wallet client**            | [`createOpenReceive()`][api-createopenreceive]                                                                                  | **your wallet** — mints invoices, reads settlement, holds the NWC code      | server-only, one per process                     |
| **Order bridge**             | [`createOpenReceiveHost()`][api-createopenreceivehost]                                                                          | **your database** — your order hooks, plus the `openreceive_payments` table | server-only, next to your models                 |
| **HTTP routes**              | [`openReceiveExpress()`][api-express] (or [Fastify][api-fastify] / [Next][api-next] / [Rails](docs/guides/quickstart-rails.md)) | **the browser** — the endpoints the checkout UI calls                       | mounted on your app by default at `/openreceive` |
| **Checkout UI** _(optional)_ | [`@openreceive/react`][api-browser] (or vue/svelte/angular/elements)                                                            | **the HTTP routes above** — creates the checkout, polls until paid          | your browser bundle                              |

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

You usually write none of that. The quickstart passes the same hooks straight
to the adapter — `openReceiveExpress({ nwc, db, loadOrder, amountForOrder,
onPaid, authorize })` — and gets the same three objects in one call. Name them
yourself only when two mounts share one wallet connection, you supply a custom
payments repository, or a test needs the order bridge without an HTTP server.
The guides and API reference call them `service` and `host`: the parameter
names every adapter expects.

### The order bridge owns one table

The order bridge is the server object between your orders and OpenReceive's
payment attempts: it calls the three hooks you hand it — `loadOrder`,
`amountForOrder`, `onPaid` — and owns one table, `openreceive_payments`, inside
your database. Keep your order model unchanged. You run that table's migration
([`npx openreceive scaffold payments`][api-scaffold] emits it for your ORM);
the library owns everything else: schema, per-order locking, write-once
settlement, reconciliation. Each row is one invoice or swap attempt. The only
link back to your app is the opaque `order_id` string handed to your hooks: no
foreign key, and OpenReceive never reads your orders table. A row commits
before the payer sees an invoice, settles once, and fulfills at most once per
order; to your app an order is simply unpaid or paid.

Schema, the attempt state machine, live-attempt rules, and the
custom-repository escape hatch: [Payment storage](docs/guides/storage.md).

### The wallet client needs two secrets

[`createOpenReceive()`][api-createopenreceive] reads the receive-only wallet
code from `NWC_URI`; optional swap providers come from `LSC_URI_PRIMARY` and
`LSC_URI_BACKUP`. Those are OpenReceive's only secret environment variables.
Your deployment supplies them (the library never loads `.env`), and none of
them may reach browser code or logs. Boot fails closed when the wallet code
can spend; the override and what it costs are in
[Security](docs/guides/security.md).

### The routes run your `authorize` on every request

The routes never inspect your session. You write one callback,
[`authorize`][api-authorize], and it runs on every order-scoped request — an
order id identifies a row but does not prove the caller owns it:

```ts
authorize: async ({ action, request, resource }) =>
  orders.authorize({ request, orderId: resource.orderId, action }),
```

A create request carries an order id, never a price: the order bridge resolves
the amount from your order. A refused attempt (order already paid, competing
live attempt) is a [`409`][api-errors] with no invoice attached.
[Authorization](docs/guides/authorization.md) covers the context object,
framework sessions, and guest orders.

### Settlement is decided by the wallet

Reconciliation is poll-based and opportunistic: every mounted payment route
runs one gated scan over pending attempts — one wallet scan per interval across
all your instances — so no background process is required. An attempt settles
only on the wallet's own finality signal (`settled_at` or state `settled`;
never a preimage alone, never a swap provider reporting "complete"), and an
unpaid attempt closes only after a wallet scan past its expiry, never on the
local clock. Optional [notification workers][api-notifworker] (Rails:
[`rake openreceive:notifications`][api-rake-notifications]) settle faster
under the same rule.

Scan gate, multi-instance behavior, and workers:
[Deploying](docs/guides/deploying.md). Swap recovery, `swap_data`, and refunds:
[Automated swaps](docs/guides/automated-swaps.md). Internals:
[Settlement reconciliation](docs/internal/settlement-sweeps.md).

### Writing your own checkout route

Most applications should not: mounting the adapter gives you the routes and
lets the shipped checkout components work against them with no glue. If you
need a flow the routes do not offer, drive `service` and `host` yourself —
mint with [`service.createCheckout`][api-createcheckout], commit with
`host.onCheckoutCreated`, and only then return the invoice. Skip the commit and
a payer can pay an invoice your database has no row for; skip `authorize`
(nothing calls it for you here) and anyone with an order id can mint against
it. The worked route, the response shape the shipped components expect, and
the settlement callback:
[Custom controller integration](docs/internal/custom-controller-integration.md).

## Run a demo

The Hello Fruit demos add products to a cart, create an order, and pay its
live Lightning invoice:

```sh
npm run demo node      # Express + React/Vue/Svelte/Angular http://localhost:3000
npm run demo static    # Static HTML + small API             http://localhost:3001
npm run demo nextjs    # Next.js fullstack                   http://localhost:3002
npm run demo rails     # Rails + host Postgres               http://localhost:3003
```

Each needs a receive-only `NWC_URI` in the root `.env`. What the command does,
what each variant shows, and the host-versus-library line the demos draw:
[Hello Fruit](examples/hello-fruit/README.md).

## Development

```sh
npm test               # the JS suite
npm run check          # contracts and secret-safety checks
npm run test:ci        # the full deterministic gate, including Ruby and demos
```

[CONTRIBUTING](CONTRIBUTING.md) has setup, ground rules, and the repository
layout; the [test command map](docs/internal/test-command-map.md) lists every
command.

## Product boundary

OpenReceive creates a Lightning invoice and verifies that it was paid. It does
not transmit money, hold funds, or hold a key. Swap routes are suggestions, not
payment guarantees: the payer uses those third-party services under their
terms ([Provider registry](docs/guides/provider-registry.md)). A live checkout
always needs a backend you control — the browser never receives the wallet
code ([Frontend checkout](docs/guides/frontend-checkout.md)).

## Documentation

Start with the [developer guides](docs/guides/README.md):

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
[api-createopenreceive]: docs/guides/api-reference.md#createopenreceive
[api-createcheckout]: docs/guides/api-reference.md#servicecreatecheckout
[api-createopenreceivehost]: docs/guides/api-reference.md#createopenreceivehost
[api-errors]: docs/guides/api-reference.md#errors
[api-express]: docs/guides/api-reference.md#openreceiveexpress
[api-fastify]: docs/guides/api-reference.md#openreceivefastify
[api-next]: docs/guides/api-reference.md#openreceivenexthandlers
[api-notifworker]: docs/guides/api-reference.md#startopenreceivenotificationworker
[api-rake-notifications]: docs/guides/api-reference.md#rake-openreceivenotifications
[api-scaffold]: docs/guides/api-reference.md#openreceive-scaffold-payments
