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

## Integrations

Each stack has an integration page and a quickstart on openreceive.org:

| Stack | Quickstart |
| --- | --- |
| [WooCommerce / WordPress](https://openreceive.org/integrations/woocommerce) | [WooCommerce quickstart](https://openreceive.org/guides/quickstart-woocommerce) |
| [Easy Digital Downloads](https://openreceive.org/integrations/easy-digital-downloads) | [Easy Digital Downloads quickstart](https://openreceive.org/guides/quickstart-edd) |
| [Paymenter](https://openreceive.org/integrations/paymenter) | [Paymenter quickstart](https://openreceive.org/guides/quickstart-paymenter) |
| [FOSSBilling](https://openreceive.org/integrations/fossbilling) | [FOSSBilling quickstart](https://openreceive.org/guides/quickstart-fossbilling) |
| [Express (Node.js)](https://openreceive.org/integrations/express) | [Express quickstart](https://openreceive.org/guides/quickstart-node) |
| [Fastify](https://openreceive.org/integrations/fastify) | [Fastify quickstart](https://openreceive.org/guides/quickstart-fastify) |
| [Next.js](https://openreceive.org/integrations/nextjs) | [Next.js quickstart](https://openreceive.org/guides/quickstart-next) |
| [NestJS](https://openreceive.org/integrations/nestjs) | [NestJS quickstart](https://openreceive.org/guides/quickstart-nestjs) |
| [Ruby on Rails](https://openreceive.org/integrations/rails) | [Rails quickstart](https://openreceive.org/guides/quickstart-rails) |
| [Django](https://openreceive.org/integrations/django) | [Django quickstart](https://openreceive.org/guides/quickstart-django) |
| [FastAPI](https://openreceive.org/integrations/fastapi) | [FastAPI quickstart](https://openreceive.org/guides/quickstart-fastapi) |
| [Laravel](https://openreceive.org/integrations/laravel) | [Laravel quickstart](https://openreceive.org/guides/quickstart-laravel) |
| [Plain PHP](https://openreceive.org/integrations/php) | [PHP quickstart](https://openreceive.org/guides/quickstart-php) |
| [BTCPay Server](https://openreceive.org/integrations/btcpay-server) | [BTCPay quickstart](https://openreceive.org/guides/quickstart-btcpay) |

On SvelteKit, Nuxt, Astro, React Router or TanStack Start, a recipe mounts the
same web-standard handler:
[SvelteKit](https://openreceive.org/guides/sveltekit-recipe),
[Nuxt](https://openreceive.org/guides/nuxt-recipe),
[Astro](https://openreceive.org/guides/astro-recipe),
[React Router](https://openreceive.org/guides/react-router-recipe),
[TanStack Start](https://openreceive.org/guides/tanstack-start-recipe).

Building on a platform? See [Vercel](https://openreceive.org/platforms/vercel),
[v0](https://openreceive.org/platforms/v0),
[Replit](https://openreceive.org/platforms/replit), or
[Lovable](https://openreceive.org/platforms/lovable). Coming from Stripe? See
[OpenReceive + Stripe](https://openreceive.org/processors/stripe).

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

Pick your stack under [Integrations](#integrations). The same quickstarts are
in this repository under [docs/guides](docs/guides/README.md).

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
  db, // pg Pool/Client, mysql2 Pool, node:sqlite, better-sqlite3, or a custom adapter
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

For manual BTCPay plugin testing with your `.env` wallet and swap providers, run
`npm run demo btcpayserver` and open **http://127.0.0.1:14180**. It configures a
mainnet store using `NWC_URI` and optional `LSC_URI_PRIMARY` / `LSC_URI_BACKUP`.
Stop it with `npm run demo btcpayserver -- --stop`; accounts, stores and invoices
are preserved. Use `-- --testkit` for funded local regtest wallets instead.
Use `npm run demo btcpayserver -- --published` to install the current Plugin
Directory package with the same login and `.env`, instead of building local source.
Every BTCPay demo start resolves and pulls the latest stable upstream server.
See the [BTCPay demo](packages/dotnet/README.md#manual-browser-demo-with-your-wallet)
for login and testing details.

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
`/plugin marketplace add OpenReceive/openreceive` in Claude Code. Already using
the Node package? Run `npx openreceive skills install` in your app to copy the
bundled skills into `.agents/skills/` (`--dir .claude/skills` for Claude Code).
[Other package install commands](https://openreceive.org/agents) cover Python,
Rails, and Laravel. OpenReceive also publishes
self-contained per-stack agent directions, `/llms.txt`, and the OpenAPI
contract at [openreceive.org/agents](https://openreceive.org/agents). Working
on OpenReceive itself? That is [AGENTS.md](AGENTS.md).

Start with the [developer guides](docs/guides/README.md). Also on openreceive.org:
[openreceive.org/guides](https://openreceive.org/guides).

- [Node quickstart](docs/guides/quickstart-node.md) ([on openreceive.org](https://openreceive.org/guides/quickstart-node))
- [Node ORM recipes](docs/guides/node-orms.md) ([on openreceive.org](https://openreceive.org/guides/node-orms))
- [Rails quickstart](docs/guides/quickstart-rails.md) ([on openreceive.org](https://openreceive.org/guides/quickstart-rails))
- [BTCPay Server quickstart](docs/guides/quickstart-btcpay.md) ([on openreceive.org](https://openreceive.org/guides/quickstart-btcpay))
- [Frontend checkout](docs/guides/frontend-checkout.md) ([on openreceive.org](https://openreceive.org/guides/frontend-checkout))
- [Headless checkout](docs/guides/headless-checkout.md) ([on openreceive.org](https://openreceive.org/guides/headless-checkout))
- [Writing your own checkout route](docs/guides/custom-checkout-route.md) ([on openreceive.org](https://openreceive.org/guides/custom-checkout-route))
- [Price feeds](docs/guides/price-feeds.md) ([on openreceive.org](https://openreceive.org/guides/price-feeds))
- [Automated swaps](docs/guides/automated-swaps.md) ([on openreceive.org](https://openreceive.org/guides/automated-swaps))
- [Lightning Swap Connect](docs/guides/lightning-swap-connect.md) ([on openreceive.org](https://openreceive.org/guides/lightning-swap-connect))
- [Environment variables](docs/guides/environment-variables.md) ([on openreceive.org](https://openreceive.org/guides/environment-variables))
- [Provider registry](docs/guides/provider-registry.md) ([on openreceive.org](https://openreceive.org/guides/provider-registry))
- [Authorization](docs/guides/authorization.md) ([on openreceive.org](https://openreceive.org/guides/authorization))
- [Rate limiting](docs/guides/rate-limiting.md) ([on openreceive.org](https://openreceive.org/guides/rate-limiting))
- [Payment storage](docs/guides/storage.md) ([on openreceive.org](https://openreceive.org/guides/storage))
- [Deploying OpenReceive](docs/guides/deploying.md) ([on openreceive.org](https://openreceive.org/guides/deploying))
- [Testing your OpenReceive integration](docs/guides/host-testing.md) ([on openreceive.org](https://openreceive.org/guides/host-testing))
- [Security](docs/guides/security.md) ([on openreceive.org](https://openreceive.org/guides/security))
- [API reference](docs/guides/api-reference.md) ([on openreceive.org](https://openreceive.org/guides/api-reference))
- [React + Material UI recipe](docs/recipes/react-material-ui.md) ([on openreceive.org](https://openreceive.org/guides/react-material-ui-recipe))
- Framework recipes: [SvelteKit](docs/recipes/sveltekit.md), [Nuxt](docs/recipes/nuxt.md), [Astro](docs/recipes/astro.md), [React Router](docs/recipes/react-router.md), [TanStack Start](docs/recipes/tanstack-start.md)
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
