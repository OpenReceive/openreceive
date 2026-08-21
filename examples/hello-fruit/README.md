# Hello Fruit

One shop, four server stacks. Each variant sells the same fruit stickers from
the same catalog, mounts OpenReceive at `/openreceive`, and delivers the
purchased SVG only after `onPaid` has marked the host order paid.

## The four variants

| Variant | Port | Mount style | Client |
| --- | --- | --- | --- |
| [`server/node-express`](server/node-express) | 3000 | `openReceiveExpress()` middleware | React, with tabs that swap in the Vue, Svelte, and Angular `<Checkout>` |
| [`server/static-html-small-api`](server/static-html-small-api) | 3001 | `openReceiveExpress()` middleware | Plain DOM plus the `<openreceive-checkout>` custom element |
| [`server/nextjs-fullstack`](server/nextjs-fullstack) | 3002 | App Router catch-all route | React Server Components + the React `<Checkout>` |
| [`server/rails`](server/rails) | 3003 | Mounted `OpenReceive::Engine` | MobX Keystone SPA over Shakapacker; ActionCable pushes on top of polling |

The first three keep host rows in a disposable local SQLite file under
`.openreceive/`; the Rails variant uses Postgres. All four keep orders and
payment attempts in separate tables, and none of them configures OpenReceive
storage — the host passes its own database handle.

Run any of them from the repository root with `npm run demo <node|static|nextjs|rails>`.

## `shared/` — host glue, not library code

Everything in [`shared/`](shared) is *host application* code that the variants
would otherwise each write for themselves. It is not part of the published
packages and nothing in `packages/js/**` imports it.

| Module | Role |
| --- | --- |
| `fruits.json`, `product.json`, `stickers/` | The catalog. The single source of product data for every variant |
| `demo-catalog.ts`, `demo-pricing.ts`, `demo-currencies.ts`, `demo-formatting.ts` | Host-owned price math and display copy |
| `demo-prepare-checkout.ts`, `openreceive-store.ts` | Order creation and the host order/attempt tables |
| `demo-express-app.ts` | The whole Express host app, shared by the two Express variants |
| `demo-delivery.ts` | Server-side post-pay delivery gate (`/delivery/:orderId/:productId`) |
| `demo-delivery-client.ts`, `demo-checkout-resume.ts`, `demo-confetti.ts` | Browser-side host behavior: waiting for `onPaid`, fetching purchased stickers, `/checkout/:orderId` resume |

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
registry. The Rails variant is the single sanctioned exception — its method
wizard is a hand port onto MobX Keystone state, because the packaged wizard
holds selection state internally. That port is checked against the packaged
surface by:

```sh
npm run test -w @openreceive/example-rails
```

which fails when `@openreceive/browser/headless` grows or renames a wizard
export the port does not mirror.

## Known simplifications

- **`static-html-small-api`** is intentionally the smallest client: no
  framework, no build-time component model, and rate limiting left off (the
  Express variant shows it on). It still renders every purchased sticker.
- **`nextjs-fullstack`** boots OpenReceive lazily per server module instance,
  which is what a serverless deployment gets; the long-lived variants boot once
  at startup.
- No variant runs a settlement timer in a web process. Discovery is the
  request-path opportunistic reconcile; the Rails variant additionally ships the
  optional `openreceive:notifications` worker as a separate container.
