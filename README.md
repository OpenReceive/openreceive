# OpenReceive

Freedom technology for inbound payments.

Accept Bitcoin payments on your website, app, or point of sale, straight into a wallet you control.

See it in action:

https://github.com/user-attachments/assets/bbc253cc-f80c-42a4-9c54-ba9b11cc1284

<!-- A GitHub upload; a bare attachment URL is the only form GitHub renders as a video player. -->

<img src="packages/js/browser/src/assets/icons/btc.svg" alt="Bitcoin" width="56">

**Bitcoin by default.** Use the internet's neutral settlement currency. Your server issues a QR code. The payer pays the QR code, and your server approves delivery of the purchase.

**Deposit-only by design.** OpenReceive exposes no payment-sending API and
does not need your wallet seed phrase: it connects with a receive-only [NWC code](https://github.com/nostr-protocol/nips/blob/master/47.md). Choose an existing
[NWC service](https://openreceive.org/get_a_nwc_code_to_receive_payments) to receive payments, or build your own NWC Service.

To run the wallet on your own hardware, use an NWC service you host yourself, like [Alby Hub](https://github.com/getAlby/hub).

**Optionally accept USDT, USDC, SOL, and ETH through swaps.** Customers pay
with a supported asset; you receive BTC over Lightning in your connected wallet.
Available assets and networks depend on your configured provider. Configure a
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

| Stack | Quickstart |
| --- | --- |
| Express / Node.js | [Express quickstart](docs/guides/quickstart-node.md) |
| Fastify | [Fastify quickstart](docs/guides/quickstart-fastify.md) |
| Next.js | [Next.js quickstart](docs/guides/quickstart-next.md) |
| Ruby on Rails | [Rails quickstart](docs/guides/quickstart-rails.md) |
| Django | [Django quickstart](docs/guides/quickstart-django.md) |
| FastAPI | [FastAPI quickstart](docs/guides/quickstart-fastapi.md) |
| Plain PHP | [PHP quickstart](docs/guides/quickstart-php.md) |
| Laravel | [Laravel quickstart](docs/guides/quickstart-laravel.md) |
| WordPress + WooCommerce | [WooCommerce quickstart](docs/guides/quickstart-woocommerce.md) |
| BTCPay Server | [BTCPay quickstart](docs/guides/quickstart-btcpay.md) |

Your application supplies authorization, the order amount, and the payment
hook. OpenReceive tracks payment attempts in your existing database and
verifies receipt in your wallet. WooCommerce and BTCPay integrations connect
that settlement to the platform's existing order or invoice lifecycle.

## Security defaults

- **Receive-only wallet access.** OpenReceive creates invoices and reads
  payments through NWC. It exposes no send-payment API and rejects
  spend-capable wallet connections by default.
- **Credentials stay on your server.** Your browser receives checkout
  instructions, never your wallet connection or swap-provider credentials.
- **You choose the wallet and provider.** OpenReceive does not hold your
  funds. Your wallet determines custody, and an optional swap provider
  handles the customer's deposit until payout or refund. Receive-only access
  limits wallet permissions; it does not remove the need to secure your app.
  See the [security guide](docs/guides/security.md).
- **Your app owns business state.** Your application owns orders; the library
  owns the `openreceive_payments` rows (they live in your database) — see
  [Payment storage](docs/guides/storage.md). OpenReceive never owns orders,
  users, prices, or fulfillment, and never requires a separate database,
  Redis, or migration runner: you pass a database handle, and the library
  owns the schema, locking, settlement write-once, and reconciliation.

## How it fits into your app

In Node.js, OpenReceive is three server objects plus an optional browser package. Each one
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

Try a working shop: add items to a cart, create an order, and pay with
Lightning or an optional swap. The download unlocks after wallet settlement.
Examples cover Node.js, Ruby, Python, PHP, and WordPress, with a shared product
catalog and each framework's own database integration.

Run a demo in Docker from the repository root:

```sh
cp -n .env.example .env   # configure your receive-only NWC_URI
npm run demo node         # Express, :3000
npm run demo django       # Django, :3006
npm run demo php          # plain PHP, :3008
npm run demo wordpress    # WooCommerce, :3009
```

The [examples directory](examples/README.md) lists every stack, its launch
command, and ways to run against fake wallets and swap providers. The
[Buy a Button README](examples/buttons/README.md) explains the shared shop,
order persistence, and checkout integration.

## Development

```sh
npm test               # the JS suite
npm run check          # contracts and secret-safety checks
npm run test:ci        # the full gate across engines, packages, docs, and demo builds
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
