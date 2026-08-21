# OpenReceive

Ship with a sensible payment default: accept Bitcoin. Your payouts land in the
most neutral, lowest-friction mutual currency on the internet—Bitcoin—while
your customers can start from balances they already hold: USDT, USDC, ETH,
SOL, and more.

OpenReceive adds uncensorable, global, permissionless inbound payments to a
website or app. Your server creates and verifies a Bitcoin Lightning BOLT11
invoice through a wallet you control. A payer can pay that invoice directly
with Lightning or, when you configure a swap provider, start with a familiar
coin and have the payment settle into Bitcoin.

OpenReceive is not a bank, exchange, wallet, broker, custodian, or payment
processor. It does not transmit money or hold customer funds. Your app brings
a server-side, receive-only Nostr Wallet Connect connection (NWC / NIP-47), and
OpenReceive helps your backend create invoices and verify settlement.

## Quickstart

Node ≥ 22, plus a receive-only NWC connection string from your wallet.

```sh
npm install openreceive @openreceive/express @openreceive/react
```

Scaffold the payments migration for your ORM and run it through your normal
migration workflow:

```sh
npx openreceive scaffold payments --orm prisma   # or drizzle | typeorm | sequelize | knex
# then run the emitted migration (e.g. npx prisma migrate dev)
```

```ts
// server: mount the routes on your existing Express app
import express from "express";
import { openReceiveExpress } from "@openreceive/express";
import { db, orders, sessions } from "./app.ts";

const app = express();
app.use(express.json());
app.use(
  openReceiveExpress({
    nwc: process.env.NWC_URI!, // receive-only; boot fails closed otherwise
    db, // your existing database handle
    loadOrder: (orderId) => orders.find(orderId),
    amountForOrder: (order) => ({ currency: "USD", value: order.total.toString() }),
    onPaid: async ({ orderId, query }) => {
      // Runs inside the settlement transaction, once per order.
      await query("UPDATE orders SET state = 'paid' WHERE id = ?", [orderId]);
    },
    authorize: async ({ action, request, resource }) =>
      orders.viewerMay(await sessions.currentUser(request), resource.orderId, action),
  }),
);
```

```tsx
// browser: the checkout renders, polls, and settles itself
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout orderId={order.id} />;
```

The compiled `styles.css` sheets (`@openreceive/react`,
`@openreceive/elements`) are self-contained — a plain
`<link rel="stylesheet">` works with no build step.

That is the whole loop: your server owns the price and the order, the payer gets
an invoice, and `onPaid` runs once inside the settlement transaction. Full
walkthrough in [docs/guides/quickstart-node.md](docs/guides/quickstart-node.md);
Rails in [docs/guides/quickstart-rails.md](docs/guides/quickstart-rails.md).

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
- **Your app owns business state.** The host owns orders; the library owns
  the `openreceive_payments` rows (they live in the host's database) — see
  [Payment storage](docs/guides/storage.md). OpenReceive never owns orders,
  users, prices, or fulfillment, and never requires a separate database,
  Redis, or migration runner: you pass a database handle, and the library
  owns the schema, locking, settlement write-once, and reconciliation.

## The host contract

Keep your order model unchanged. OpenReceive owns one `openreceive_payments`
table inside your existing database: you run its migration through your own
workflow (`npx openreceive scaffold payments` emits it for your ORM) and pass a
database handle. The library owns the schema, per-order commit locking,
write-once settlement, and the reconciliation state machine:

```ts
import { createOpenReceiveHost } from "@openreceive/http";

const host = createOpenReceiveHost({
  db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
  loadOrder: (orderId) => orders.find(orderId),
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
```

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

Implementing a custom `OpenReceivePaymentRepository` is the documented advanced
escape hatch, not the quickstart. See [Payment storage](docs/guides/storage.md).

## Direct Node API

```ts
import { createOpenReceiveHost } from "@openreceive/http";
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive();
const host = createOpenReceiveHost({ db, loadOrder, amountForOrder, onPaid });

const checkout = await openreceive.createCheckout({
  orderId: order.id,
  amount: { currency: "USD", value: order.total.toString() },
});

// Commit the attempt row BEFORE exposing payer instructions. The mounted
// routes do this for you; a direct createCheckout call persists nothing on
// its own, and an uncommitted invoice is invisible to reconciliation — it
// could be paid and never settle the order.
await host.onCheckoutCreated({
  orderId: order.id,
  paymentHash: checkout.paymentHash,
  checkout,
});
```

`createOpenReceive()` reads the receive-only wallet connection from `NWC_URI`.
Optional swap connections come from `LSC_URI_PRIMARY` and `LSC_URI_BACKUP`.
These are the only OpenReceive secret environment variables.
The library does not load `.env` itself; the host entry point or deployment
platform supplies the environment. Pass `nwc` explicitly only for an
intentional runtime override, such as an isolated test.

Boot preflight fails closed when the wallet advertises spend methods such as
`pay_invoice`; the explicit override is `allowSpendCapableWallet: true` or
`OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`. See
[Security](docs/guides/security.md).

The service's `checkPayment({ paymentHash, createdAt })` is a pure wallet
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
or Rails. OpenReceive never inspects the host session. The `host` integration
resolves authoritative prices, selects committed attempts, and persists new
ones; your application supplies authorization.

A create request supplies an order ID, never its own price. The host resolves
the authoritative amount from its order:

```ts
app.use(openReceiveExpress({
  // The configured OpenReceive service holds the receive-only wallet connection.
  // Keep this object on the server; never expose its NWC configuration to clients.
  service: openreceive,

  // Authentication and authorization belong entirely to your application.
  // An order ID identifies a row, but possession of that ID is not proof that
  // the caller owns the order.
  authorize: async ({ action, request, resource }) => {
    return orders.authorize({
      request,
      orderId: resource.orderId,
      action,
    });
  },

  host, // createOpenReceiveHost({ db, loadOrder, amountForOrder, onPaid })
}));
```

The attempt row commits before the payer receives the invoice. A refused
commit (already-paid order, competing live attempt) gets a `409` response — an
infrastructure failure a retryable `503` — with no payer instructions either
way. Rails hosts mount
the engine and retain their own authentication and `current_user` logic. JSON
checkout routes skip Rails form CSRF; host `authorize` is the auth boundary.

## Settlement and swaps

Settlement detection is poll-based: reconciliation scans the wallet with
bounded `list_transactions` reads over the pending attempts. Optional NWC-02
notification workers (Node `startOpenReceiveNotificationWorker`, Rails
`rake openreceive:notifications`) carry authenticated wallet data: a settled
`payment_received` payload settles the matching pending attempt directly over
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
routes. Refund calls are host-authorized and refresh provider state immediately
before acting.

Provider completion by itself never fulfills an order. The receiving wallet's
settled transaction remains authoritative.

## Repository map

- `spec/` is the source of truth for schemas, shared data, test vectors, and the
  shipped HTTP contract.
- `packages/js/` contains the core contracts, Node NWC service, HTTP routes,
  Express/Fastify/Next adapters, browser helpers, provider data, testkit,
  elements, and React/Vue/Svelte/Angular packages.
- `packages/ruby/` contains the dependency-free core, the Service and Rack app,
  and the mountable Rails engine—a second settlement implementation checked
  against shared vectors.
- `examples/hello-fruit/server/` contains Express, static HTML, Next.js, and
  Rails demos. Demo order models are ordinary host application code.
- `tools/` contains validation, conformance, package-smoke, documentation, and
  live-wallet helpers.

Version numbers are deliberately independent per domain: the package/workspace
release is `0.1.1`, the OpenAPI HTTP contract is `0.4.0`, and the AsyncAPI event
contract is `0.2.0`; each is versioned inside its own file and none of them
tracks the others.

## Run a demo

The Hello Fruit demos let you add products to a cart, create a host order, and
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
- [Testing an OpenReceive host](docs/guides/host-testing.md)
- [Security](docs/guides/security.md)
- [API reference](docs/guides/api-reference.md)
- [React + Material UI recipe](docs/recipes/react-material-ui.md)
- [Normative HTTP contract](spec/openapi/openreceive-http.v1.yaml)
- [Contributor and operator docs](docs/internal/README.md)
