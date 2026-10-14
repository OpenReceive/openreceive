# Astro recipe

OpenReceive ships no Astro package. An Astro endpoint takes a Web-standard
`Request` and returns a `Response`, and so does `@openreceive/http`, so the
integration is the route below. Your server code creates each Lightning
invoice, the payment goes straight to your wallet, and payment attempts are
stored in your app's database. There is no OpenReceive account and no
background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

This recipe was checked with `astro` 7.3, `@astrojs/node` 11.1 (standalone)
and `@openreceive/*` 0.4.25. The built app ran on Node in Docker, with
Postgres and a test wallet on a public NWC relay. In Chromium, the buyer's
checkout page showed the Lightning invoice. A stranger got 403 from the
payment routes and 404 from the page, and a request that named its own amount
got 400. When the wallet marked the invoice paid, the page showed it paid and
`onPaid` marked the order paid.

```sh
npx astro add node
npm install @openreceive/http @openreceive/elements pg
```

## Where it runs

On Node, with `@astrojs/node`. The payment route and the checkout page render
on demand (`prerender = false`); the rest of the site can stay static. The
wallet connection and your database driver need Node, so the route cannot run
on an edge runtime. The Vercel and Netlify adapters deploy Node functions:
read [Bitcoin checkout on serverless hosts](../guides/serverless.md) first.
For Cloudflare Workers, the [TanStack Start recipe](tanstack-start.md#where-it-runs)
explains what a Worker needs. This recipe was not run on those hosts.

## Secrets

Declare them in `astro.config.mjs`. A `secret` is read when the server runs,
never written into the build:

```js
// astro.config.mjs
import { defineConfig, envField } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  adapter: node({ mode: "standalone" }),
  env: {
    schema: {
      NWC_URI: envField.string({ context: "server", access: "secret" }),
      DATABASE_URL: envField.string({ context: "server", access: "secret" }),
    },
  },
});
```

## The payment route

```ts
// src/lib/openreceive.ts
import { createStack, type Stack } from "@openreceive/http";
import type { APIContext } from "astro";
import { NWC_URI } from "astro:env/server";
import { db } from "./db"; // your existing pg Pool
import { findOrder } from "./orders"; // your own orders

let stack: Stack | undefined;

// Built on the first request, not at import, so the build never connects
// to the wallet.
function openReceive(): Stack {
  stack ??= createStack({
    wallet: { nwc: NWC_URI },
    storage: {
      db,
      // Runs once, inside the transaction that records the payment.
      onPaid: async ({ reference, paidAt, query }) => {
        await query(
          "UPDATE orders SET state = 'paid', paid_at = $1 WHERE id = $2 AND state = 'awaiting_payment'",
          [paidAt, reference],
        );
      },
    },
    // The price comes from the order row, never from the request.
    amountFor: async (reference) => {
      const order = await findOrder(reference);
      return order?.state === "awaiting_payment"
        ? { currency: order.currency, value: order.amount, description: order.title }
        : null;
    },
    // Only the buyer may pay for their order.
    authorize: async ({ native, resource }) => {
      const context = native as APIContext;
      const order = resource.reference ? await findOrder(resource.reference) : undefined;
      return Boolean(order && order.visitor === context.cookies.get("visitor")?.value);
    },
    // The client address the adapter reports.
    rateLimiting: {
      ip: ({ native }) => (native as APIContext).clientAddress,
    },
  });
  return stack;
}

export function handleOpenReceive(context: APIContext): Promise<Response> {
  return openReceive().handler(context.request, { native: context });
}
```

```ts
// src/pages/openreceive/[...path].ts — every route under /openreceive/
import type { APIRoute } from "astro";
import { handleOpenReceive } from "../../lib/openreceive";

export const prerender = false;

export const GET: APIRoute = (context) => handleOpenReceive(context);
export const POST: APIRoute = (context) => handleOpenReceive(context);
```

`native` is the endpoint's `APIContext`, so `authorize` can check the
session your app already has: its cookies, or the user your middleware puts
in `context.locals`. The [Next.js quickstart](../guides/quickstart-next.md)
explains each hook. They are the same here.

One stack serves the whole server process. Astro's origin check refuses
cross-site form posts. The checkout sends JSON, which it lets through.
`clientAddress` is the socket address. Behind your own reverse proxy, list
your domain in `security.allowedDomains`: Astro then takes the payer's
address from `x-forwarded-for` ([Rate limiting](../guides/rate-limiting.md)).

## Your database

`db` is a `pg` Pool, `node:sqlite` or `better-sqlite3`, or one of the
adapters in [Node ORM recipes](../guides/node-orms.md). With Drizzle, pass
the `pg` Pool underneath it.

Create OpenReceive's two tables with your migrations
(`npx openreceive scaffold payments --orm <your orm>`), or run
`paymentsSchemaSql("postgres")` from `@openreceive/http` once. It is
idempotent. See [Payment storage](../guides/storage.md).

## The checkout page

The page needs no UI framework: it uses the `<openreceive-checkout>` element.
With React, Vue or Svelte in your Astro app, the `@openreceive/react`, `vue`
or `svelte` component works as a `client:load` island instead.

```astro
---
// src/pages/checkout/[reference].astro
import "@openreceive/elements/styles.css";
import { findOrder } from "../../lib/orders";

export const prerender = false;

const order = await findOrder(Astro.params.reference ?? "");
if (!order || order.visitor !== Astro.cookies.get("visitor")?.value) {
  return new Response(null, { status: 404 });
}
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Checkout</title>
  </head>
  <body>
    <openreceive-checkout reference={order.id} prefix="/openreceive"></openreceive-checkout>
    <script>
      import { defineElements } from "@openreceive/elements";
      defineElements();
    </script>
  </body>
</html>
```

The element starts the checkout in the browser. The payer picks Bitcoin and
gets the invoice. Keep it at the order's own URL: a payer with a swap deposit
in flight comes back to it ([Swap refunds](../guides/swap-refunds.md)).

## Settings

- `NWC_URI`: a receive-only code from your wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
- `DATABASE_URL`: your Postgres. On serverless hosts use the pooled URL.
- Optional: `LSC_URI_PRIMARY` for swaps
  ([set one up](https://openreceive.org/set_up_swap_provider)), and
  `LSC_URI_BACKUP`. OpenReceive reads these, and `LOG_LEVEL`, straight from
  `process.env`, not through `astro:env`.

In production, set them all in the server's environment. In development,
`astro dev` reads `.env` for the variables in your schema but keeps the file
out of `process.env`. To try swaps locally, start it with
`node --env-file=.env node_modules/.bin/astro dev`. Never declare them with
`context: "client"`, which would send them to the browser.

No worker or cron job is needed. Each request to the payment routes also
checks the wallet for settled invoices, through a lock in your database. A
payer who closes the tab is settled on the next request.
