# Hello Fruit

One shop, three Node server stacks. Each variant sells the same fruit stickers
from the same catalog, mounts OpenReceive at `/openreceive`, and delivers the
purchased SVG only after `onPaid` has marked the host order paid.

The Rails variant of this shop is gone; [`examples/buttons`](../buttons) — "Buy
a Button" — replaced it, showing the same boundary against real persistence: a
products table, a signed-cookie visitor table, an orders table, and a public
feed of every paid order on the site. Run it with `npm run demo buttons`.

## The three variants

| Variant | Port | Mount style | Client |
| --- | --- | --- | --- |
| [`server/node-express`](server/node-express) | 3000 | `openReceiveExpress()` middleware | React, with tabs that swap in the Vue, Svelte, and Angular `<Checkout>` |
| [`server/static-html-small-api`](server/static-html-small-api) | 3001 | `openReceiveExpress()` middleware | Plain DOM plus the `<openreceive-checkout>` custom element |
| [`server/nextjs-fullstack`](server/nextjs-fullstack) | 3002 | App Router catch-all route | React Server Components + the React `<Checkout>` |

All three keep host rows in a disposable local SQLite file under
`.openreceive/`, keep orders and payment attempts in separate tables, and none
of them configures OpenReceive storage — the host passes its own database
handle.

Run any of them from the repository root with `npm run demo <node|static|nextjs>`.
The command creates a root `.env` from `.env.example` if it is missing,
validates `NWC_URI`, and runs that variant's Docker Compose stack; anything
after `--` is forwarded to `docker compose up` (`npm run demo node -- -d`).
Set a receive-only NWC URI before creating a checkout. Optional automated swaps
read `LSC_URI_PRIMARY` and `LSC_URI_BACKUP`; provider credentials never reach
the browser.

## `shared/` — host glue, not library code

Everything in [`shared/`](shared) is *host application* code that the variants
would otherwise each write for themselves. It is not part of the published
packages and nothing in `packages/js/**` imports it.

Every module, grouped by what it is:

| Module | Role |
| --- | --- |
| `fruits.json`, `product.json`, `stickers/` | The catalog. The single source of product data for every variant |
| `demo-catalog.ts`, `demo-pricing.ts`, `demo-currencies.ts`, `demo-formatting.ts` | Host-owned price math and display copy |
| `demo-order.ts`, `demo-prepare-checkout.ts`, `openreceive-store.ts` | The order type, order creation, and the host order/attempt tables |
| `openreceive-config.ts`, `demo-nwc.ts`, `demo-price-feeds.ts` | How each variant builds its OpenReceive service: wallet client, price feeds, shared options |
| `demo-express-app.ts`, `production-server.ts` | The whole Express host app (shared by the two Express variants) and its production entry point |
| `demo-delivery.ts` | Server-side post-pay delivery gate (`/delivery/:orderId/:productId`) |
| `demo-delivery-client.ts`, `demo-checkout-resume.ts`, `demo-confetti.ts` | Browser-side host behavior: waiting for `onPaid`, fetching purchased stickers, `/checkout/:orderId` resume |
| `demo-shop-app.tsx` | The React shop UI the React-based variants mount |
| `demo-logging.ts`, `demo-browser-logging.ts` | Server and browser log sinks wired to `LOG_LEVEL` |
| `demo-testkit-controls.ts` | `DEMO_WALLET=testkit` controls the E2E suite drives (settle an invoice, step a swap) |
| `copy-openreceive-payment-icons-plugin.ts` | Vite plugin that copies packaged icons next to the emitted JS |

## Host versus library

The line these demos exist to draw:

- **The host** creates the order, resolves its amount from its own rows,
  authorizes the request, fulfills in `onPaid`, and serves the deliverable.
  That is every file under `shared/` and every route the variants declare.
- **The library** creates the invoice, drives the payer UI, polls, runs swaps,
  and reconciles. That is `@openreceive/*` — mounted, never reimplemented.

So: no variant forks library UI. Components come from `@openreceive/react`,
`@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular`, or
`@openreceive/elements`; class strings come from `@openreceive/browser`'s
registry.

For the other story — a host that builds its OWN components on
`@openreceive/browser/headless` and drives them from
[mobx-keystone](https://mobx-keystone.js.org) stores — read
[`examples/buttons`](../buttons). It re-implements no engine either: the poll
loop, the backoff, the countdown and the staged swap-refund address all come
from the package. The custom part is only the store layer between the engine
and the components, which is exactly what a headless integration is.

## Known simplifications

- **`static-html-small-api`** is intentionally the smallest client: no
  framework, no build-time component model, and rate limiting left off (the
  Express variant shows it on). It still renders every purchased sticker.
- **`nextjs-fullstack`** boots OpenReceive lazily per server module instance,
  which is what a serverless deployment gets; the long-lived variants boot once
  at startup.
- No variant runs a settlement timer in a web process. Discovery is the
  request-path opportunistic reconcile.
