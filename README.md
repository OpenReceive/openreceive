# OpenReceive

Freedom technology for inbound payments.

Accept Bitcoin payments on your website, app, or point of sale, straight into a wallet you control.

<img src="packages/js/browser/src/assets/icons/btc.svg" alt="Bitcoin" width="56">

**Bitcoin by default.** Use the internet's neutral settlement currency. Your server issues a QR code. The payer pays the QR code, and your server approves delivery of the purchase.

**Deposit-only by design.** OpenReceive exposes no payment-sending API and
never holds a key: it connects with only a spec-compliant receive-only [NWC code](https://github.com/nostr-protocol/nips/blob/master/47.md). Choose an existing
[NWC service](https://openreceive.org/get_a_nwc_code_to_receive_payments) to receive payments, or build your own NWC Service.

To run the wallet on your own hardware, use an NWC service you host yourself, like [Alby Hub](https://github.com/getAlby/hub).

**Optionally swap in other currencies.** Not every customer holds Bitcoin.
Configure any
[swap provider](https://openreceive.org/set_up_swap_provider) to receive altcoins. Use any swap provider that implements the
[FixedFloat / Lightning-Swap API](https://lightning-swap.com/api_docs), or build your own.

Optional Inbound Currencies:

| Pay with                                                                                                  | On network                                                                                                                                                                                                                                                                                        | Settles in                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| <img src="packages/js/browser/src/assets/icons/usdt.svg" alt="USDT" width="28"> &nbsp;**USDT** (Tether)   | <img src="packages/js/browser/src/assets/icons/trx.svg" alt="Tron" width="18"> Tron &nbsp;&nbsp; <img src="packages/js/browser/src/assets/icons/sol.svg" alt="Solana" width="18"> Solana &nbsp;&nbsp; <img src="packages/js/browser/src/assets/icons/eth.svg" alt="Ethereum" width="18"> Ethereum | <img src="packages/js/browser/src/assets/icons/btc.svg" alt="Bitcoin" width="18"> Bitcoin |
| <img src="packages/js/browser/src/assets/icons/usdc.svg" alt="USDC" width="28"> &nbsp;**USDC** (USD Coin) | <img src="packages/js/browser/src/assets/icons/sol.svg" alt="Solana" width="18"> Solana &nbsp;&nbsp; <img src="packages/js/browser/src/assets/icons/eth.svg" alt="Ethereum" width="18"> Ethereum                                                                                                  | <img src="packages/js/browser/src/assets/icons/btc.svg" alt="Bitcoin" width="18"> Bitcoin |
| <img src="packages/js/browser/src/assets/icons/sol.svg" alt="SOL" width="28"> &nbsp;**SOL** (Solana)      | <img src="packages/js/browser/src/assets/icons/sol.svg" alt="Solana" width="18"> Solana                                                                                                                                                                                                           | <img src="packages/js/browser/src/assets/icons/btc.svg" alt="Bitcoin" width="18"> Bitcoin |
| <img src="packages/js/browser/src/assets/icons/eth.svg" alt="ETH" width="28"> &nbsp;**ETH** (Ether)       | <img src="packages/js/browser/src/assets/icons/eth.svg" alt="Ethereum" width="18"> Ethereum                                                                                                                                                                                                       | <img src="packages/js/browser/src/assets/icons/btc.svg" alt="Bitcoin" width="18"> Bitcoin |

## Install

```sh
# Node: an HTTP adapter for your framework, plus the checkout UI for yours
npm install @openreceive/express @openreceive/react
```

Swap `@openreceive/express` for `@openreceive/fastify` or `@openreceive/next`,
and `@openreceive/react` for `@openreceive/vue`, `@openreceive/svelte`,
`@openreceive/angular`, or `@openreceive/elements` (framework-free custom
element). On Rails:

```ruby
# Gemfile
gem "openreceive-rails"
```

## Quickstart

Pick your stack:

| Stack         | Quickstart                                            |
| ------------- | ----------------------------------------------------- |
| Node.js       | [Node quickstart](docs/guides/quickstart-node.md)     |
| Ruby on Rails | [Rails quickstart](docs/guides/quickstart-rails.md)   |
| BTCPay Server | [BTCPay quickstart](docs/guides/quickstart-btcpay.md) |

On Node and Rails: your server owns the price and the order, the payer gets
a QR code to pay, and your [`onPaid`][api-onpaid] hook runs once inside the
settlement transaction. On BTCPay Server the plugin makes your NWC wallet the
store's Lightning node, and BTCPay's own invoices and settlement do the rest.

## Security defaults

- OpenReceive does not transmit money or hold customer funds. OpenReceive only helps your
  backend create payment QR codes and safely verify settlement.
- OpenReceive cannot spend your funds.
  1. An attacker who gains control of your server gets no reward:
     A receive-only NWC code cannot spend.
  2. Every payment settles as a private, immutable Bitcoin Lightning payment, swapped from other
     currencies as necessary. Accept ETH, SOL, USDT, and USDC without censorship risks.
  3. See [Security](docs/guides/security.md) guide.
- **Your app owns business state.** Your application owns orders; the library
  owns the `openreceive_payments` rows (they live in your database) — see
  [Payment storage](docs/guides/storage.md). OpenReceive never owns orders,
  users, prices, or fulfillment, and never requires a separate database,
  Redis, or migration runner: you pass a database handle, and the library
  owns the schema, locking, settlement write-once, and reconciliation.

## How it fits into your app

OpenReceive is three server objects plus an optional browser package. Each one
talks to a different side of your app, and each has an obvious home:

| Piece                        | You build it with                                                                                                               | It talks to                                                            | It lives                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| **Wallet client**            | [`createOpenReceive()`][api-createopenreceive]                                                                                  | **your wallet** — mints invoices, reads settlement, holds the NWC code | server-only, one per process                     |
| **Host**                     | [`createHost()`][api-createopenreceivehost]                                                                                     | **your database** — your hooks, plus the `openreceive_payments` table  | server-only, next to your models                 |
| **HTTP routes**              | [`openReceiveExpress()`][api-express] (or [Fastify][api-fastify] / [Next][api-next] / [Rails](docs/guides/quickstart-rails.md)) | **the browser** — the endpoints the checkout UI calls                  | mounted on your app by default at `/openreceive` |
| **Checkout UI** _(optional)_ | [`@openreceive/react`][api-browser] (or vue/svelte/angular/elements)                                                            | **the HTTP routes above** — creates the checkout, polls until paid     | your browser bundle                              |

Only that last row is genuinely optional. Take the drop-in components, build
your own on the semver-stable `@openreceive/browser/headless` engine, or skip
our browser packages altogether and call the routes yourself — the server side
is identical either way. See
[Headless checkout](docs/guides/headless-checkout.md).

The three server pieces:

```ts
import { openReceiveExpress } from "@openreceive/express";
import { createHost } from "@openreceive/http";
import { createOpenReceive } from "@openreceive/node";

// 1. The wallet client. Reads NWC_URI; never let this reach client code.
const service = await createOpenReceive();

// 2. The host: your database and your price.
const host = createHost({
  db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
  // The authoritative price for a reference (here, your order id) — never
  // taken from payer input.
  // OpenReceive converts this exact decimal into the invoice amount; null
  // means there is nothing to pay for (404).
  amountFor: async (reference) => {
    const order = await orders.find(reference);
    return order
      ? { currency: order.currency, value: order.total.toString() }
      : null;
  },
  onPaid: async ({ reference, query }) => {
    // Runs inside the settlement transaction, only for the order's first
    // settled attempt. Update the order or insert an outbox row here.
    await query("UPDATE orders SET state = 'paid' WHERE id = ?", [reference]);
  },
});

// 3. The HTTP routes. `authorize` is your own access check: it runs on every
//    reference-scoped request, because a reference alone does not prove ownership.
app.use(
  openReceiveExpress({
    service,
    host,
    authorize: async ({ action, request, resource }) =>
      orders.authorize({ request, reference: resource.reference, action }),
  }),
);
```

### The OpenReceive host

The host is the server object between your app and OpenReceive's payment
attempts: it calls the two hooks you hand it — `amountFor`, `onPaid` — and
owns one table, `openreceive_payments`, inside your database. You run that
table's migration ([`npx openreceive scaffold payments`][api-scaffold] emits it
for your ORM); the library owns everything else: schema, per-reference locking,
write-once settlement, reconciliation.

The `reference` is a string you choose, and it is the fulfillment identity:
your order id — one per thing you fulfill, created before checkout, kept
across retries, never reused. OpenReceive never looks inside it, but `onPaid`
runs once per reference, a new checkout under a reference that already
settled is refused with 409, and a fresh id per page load lets one order be
paid twice. Each row is one invoice or swap attempt under a reference. A row
commits before the payer sees an invoice, settles once, and fulfills at most
once per reference; to your app an order is simply unpaid or paid.

Schema, the attempt state machine, live-attempt rules, and the
custom-repository escape hatch: [Payment storage](docs/guides/storage.md).

### Only one secret required to get started

[`createOpenReceive()`][api-createopenreceive] reads the receive-only wallet
code from `NWC_URI`; optional swap providers come from `LSC_URI_PRIMARY` and
`LSC_URI_BACKUP`. Those are OpenReceive's only secret environment variables.
See [Environment variables](docs/guides/environment-variables.md).

### The routes run your `authorize` on every request

The routes never inspect your session. You write one callback,
[`authorize`][api-authorize] (step 3 above), and it runs on every reference-scoped
request — a reference identifies a row but does not prove the caller owns it.
The context carries the `action` (`checkout.create`, `payment.check`, …), the
Web-standard `request`, and the untrusted `resource` selectors the payer sent;
return `false` for `403`.

A create request carries a reference, never a price: your `amountFor` hook
resolves the amount. A refused attempt (order already paid, competing
live attempt) is a [`409`][api-errors] with no invoice attached.
[Authorization](docs/guides/authorization.md) covers the context object,
framework sessions, and guest orders.

### Settlement is decided by the wallet

OpenReceive checks your wallet for payment while serving the checkout routes,
so no background process is required. An order is marked paid only when the
wallet itself reports the payment final — never from a preimage the payer
presents, never from a swap provider reporting "complete" — and an unpaid
invoice is closed only once the wallet confirms it went unpaid, not on your
server's clock. Optional [notification workers][api-notifworker] (Rails:
[`rake openreceive:notifications`][api-rake-notifications]) settle faster
under the same rule.

How settlement is driven, multi-instance behavior, and workers:
[Deploying](docs/guides/deploying.md). Swap recovery, `swap_data`, and refunds:
[Automated swaps](docs/guides/automated-swaps.md).

### Writing your own checkout route

Most applications should not — mounting the adapter gives you the routes, and
the shipped checkout components work against them with no glue. If you need a
flow the routes do not offer:
[Writing your own checkout route](docs/guides/custom-checkout-route.md).

## Run a demo

One shop, four stacks. You add buttons to a cart, check out to create an order,
and pay that order with a real Lightning invoice from your own wallet or a
stablecoin swap; the download unlocks only after `onPaid` marks the order paid.

```sh
npm run demo node      # Buy a Button — Express + React/Vue/Svelte/Angular  http://localhost:3000
npm run demo static    # Buy a Button — static HTML, no framework           http://localhost:3001
npm run demo nextjs    # Buy a Button — Next.js app router                  http://localhost:3002
npm run demo buttons   # Buy a Button — Rails + host Postgres               http://localhost:3003
```

[Buy a Button](examples/buttons) is the persistence story: a products table, a
visitor remembered by a signed cookie, an orders table, and a public feed of
every paid order on the site, with three lambdas as the entire bridge to
OpenReceive. The four stacks share one shop — the UI, the wire types and the
Node server live once in `examples/buttons/shared/` and each stack under
`server/` is a thin host with its own routing, database idiom and build.

They differ in exactly two interesting ways, and both are on purpose: Rails
pushes settlement over ActionCable while the Node stacks poll, and node-express
plugs the packaged `<Checkout>` into the shared shop behind React / Vue /
Svelte / Angular tabs while the others render the keystone-driven checkout.

Every demo needs a receive-only `NWC_URI` in the root `.env`. The
[Buy a Button README](examples/buttons/README.md) explains what each command
starts and which parts of the code belong to the shop and which to the library.

## Development

```sh
npm test               # the JS suite
npm run check          # contracts and secret-safety checks
npm run test:ci        # the full deterministic gate, including Ruby and demos
```

[CONTRIBUTING](CONTRIBUTING.md) has setup, ground rules, and the repository
layout; the [test command map](docs/internal/test-command-map.md) lists every
command.

## Documentation

Integrating with a coding agent? OpenReceive ships installable
[agent skills](skills/) — `npx skills add OpenReceive/openreceive`, or
`/plugin marketplace add OpenReceive/openreceive` in Claude Code — plus
self-contained per-stack agent directions, `/llms.txt`, and the OpenAPI
contract at [openreceive.org/agents](https://openreceive.org/agents). Working
on OpenReceive itself? That is [AGENTS.md](AGENTS.md).

Start with the [developer guides](docs/guides/README.md):

- [Node quickstart](docs/guides/quickstart-node.md)
- [Node ORM recipes](docs/guides/node-orms.md)
- [Rails quickstart](docs/guides/quickstart-rails.md)
- [BTCPay Server quickstart](docs/guides/quickstart-btcpay.md)
- [Frontend checkout](docs/guides/frontend-checkout.md)
- [Headless checkout](docs/guides/headless-checkout.md)
- [Writing your own checkout route](docs/guides/custom-checkout-route.md)
- [Price feeds](docs/guides/price-feeds.md)
- [Automated swaps](docs/guides/automated-swaps.md)
- [Lightning Swap Connect](docs/guides/lightning-swap-connect.md)
- [Environment variables](docs/guides/environment-variables.md)
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
[api-createopenreceivehost]: docs/guides/api-reference.md#createhost
[api-errors]: docs/guides/api-reference.md#errors
[api-express]: docs/guides/api-reference.md#openreceiveexpress
[api-fastify]: docs/guides/api-reference.md#openreceivefastify
[api-next]: docs/guides/api-reference.md#openreceivenexthandlers
[api-notifworker]: docs/guides/api-reference.md#startnotificationworker
[api-onpaid]: docs/guides/api-reference.md#onpaid
[api-rake-notifications]: docs/guides/api-reference.md#rake-openreceivenotifications
[api-scaffold]: docs/guides/api-reference.md#openreceive-scaffold-payments
