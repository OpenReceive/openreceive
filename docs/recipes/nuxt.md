# Nuxt recipe

OpenReceive ships no Nuxt package. A Nuxt server route can hand the request
to `@openreceive/http` as a Web-standard `Request` and send back the
`Response` it returns, so the integration is the route below. Your server code
creates each Lightning invoice, the payment goes straight to your wallet, and
payment attempts are stored in your app's database. There is no OpenReceive
account and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

This recipe was checked with `nuxt` 4.6 (Nitro 2, h3 1.15) and
`@openreceive/*` 0.4.25. The built app ran on Node in Docker
(`node .output/server/index.mjs`), with Postgres and a test wallet on a public
NWC relay. In Chromium, the buyer's checkout page showed the Lightning
invoice. A stranger got 403 from the payment routes and 404 from the page, and
a request that named its own amount got 400. When the wallet marked the
invoice paid, the page showed it paid and `onPaid` marked the order paid.

```sh
npm install @openreceive/http @openreceive/vue pg
```

## Where it runs

On Node, with Nitro's default `node-server` preset. The wallet connection and
your database driver need Node, so the route cannot run on an edge runtime.
The Vercel, Netlify and AWS Lambda presets deploy Node functions: read
[Bitcoin checkout on serverless hosts](../guides/serverless.md) first. For
Cloudflare Workers, the [TanStack Start recipe](tanstack-start.md#where-it-runs)
explains what a Worker needs. This recipe was not run on those hosts.

## The payment route

Files in `server/` run only on the server, and Nuxt auto-imports the h3
helpers and everything in `server/utils/` there:

```ts
// server/utils/openreceive.ts
import { createStack, type Stack } from "@openreceive/http";
import type { H3Event } from "h3";

let stack: Stack | undefined;

// Built on the first request, not at import, so the build and prerendering
// never connect to the wallet.
function openReceive(): Stack {
  stack ??= createStack({
    wallet: { nwc: process.env.NWC_URI ?? "" },
    storage: {
      db, // your existing pg Pool, from server/utils/db.ts
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
      const order = await findOrder(reference); // your own orders
      return order?.state === "awaiting_payment"
        ? { currency: order.currency, value: order.amount, description: order.title }
        : null;
    },
    // Only the buyer may pay for their order.
    authorize: async ({ native, resource }) => {
      const event = native as H3Event;
      const order = resource.reference ? await findOrder(resource.reference) : undefined;
      return Boolean(order && order.visitor === getCookie(event, "visitor"));
    },
    // The socket address. Behind your own proxy, pass { xForwardedFor: true }.
    rateLimiting: {
      ip: ({ native }) => getRequestIP(native as H3Event),
    },
  });
  return stack;
}

export function handleOpenReceive(event: H3Event): Promise<Response> {
  return openReceive().handler(toWebRequest(event), { native: event });
}
```

```ts
// server/routes/openreceive/[...path].ts — every route under /openreceive/
export default defineEventHandler((event) => handleOpenReceive(event));
```

Put it in `server/routes/`, not `server/api/`, which would add `/api` to
the path. `native` is the request's `H3Event`, so `authorize` can check the
session your app already has: its cookies, or the user your session module
reads from the event. The [Next.js quickstart](../guides/quickstart-next.md)
explains each hook. They are the same here.

One stack serves the whole server process. `getRequestIP` returns the socket
address. Behind your own reverse proxy, `{ xForwardedFor: true }` reads the
first address in `x-forwarded-for`, which is safe only when that proxy sets
the header ([Rate limiting](../guides/rate-limiting.md)).

## Your database

`db` is a `pg` Pool, `node:sqlite` or `better-sqlite3`, or one of the
adapters in [Node ORM recipes](../guides/node-orms.md). With Drizzle, pass
the `pg` Pool underneath it.

Create OpenReceive's two tables with your migrations
(`npx openreceive scaffold payments --orm <your orm>`), or run
`paymentsSchemaSql("postgres")` from `@openreceive/http` once. It is
idempotent. See [Payment storage](../guides/storage.md).

## The checkout page

The page asks your own server route whether this visitor owns the order:

```ts
// server/api/checkout/[reference].get.ts
export default defineEventHandler(async (event) => {
  const order = await findOrder(getRouterParam(event, "reference") ?? "");
  if (!order || order.visitor !== getCookie(event, "visitor")) {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  return { reference: order.id, swapPaymentHash: order.swapPaymentHash ?? undefined };
});
```

```vue
<!-- app/pages/checkout/[reference].vue -->
<script setup lang="ts">
import Checkout from "@openreceive/vue/checkout.vue";
import "@openreceive/vue/styles.css";

const route = useRoute();
// During server rendering, useFetch passes the visitor's cookies to your own routes.
const { data, error } = await useFetch(`/api/checkout/${route.params.reference}`);
if (error.value) {
  throw createError({ statusCode: 404, statusMessage: "Not found", fatal: true });
}
let saved = data.value?.swapPaymentHash; // the order row's swap_payment_hash

// With swaps on: keep a new swap's payment hash on the order row.
function onState(event: Event) {
  const { state } = (event as CustomEvent).detail;
  if (state.rail !== "swap" || !state.payment_hash || state.payment_hash === saved) return;
  saved = state.payment_hash;
  $fetch(`/api/orders/${data.value?.reference}/swap-hash`, {
    method: "POST",
    body: { payment_hash: saved },
  });
}
</script>

<template>
  <Checkout v-if="data" :reference="data.reference" prefix="/openreceive" resumable
    :resume-payment-hash="data.swapPaymentHash" :on-state="onState" />
</template>
```

The page renders on the server and starts the checkout in the browser. The
payer picks Bitcoin and gets the invoice.

With swaps on, a swap deposit that arrives short or late is refunded on a later
visit to this page, sometimes hours later or from another browser. So the page
is `resumable`, and the `onState` prop keeps the swap's payment hash on the
order row. It receives the element's event, with the state at
`event.detail.state`.

`server/api/orders/[reference]/swap-hash.post.ts` is a route of your own. It
checks that the order belongs to this payer, as the page's API route does, and
that the hash is 64 hex characters, then saves it in a `swap_payment_hash`
column, empty until a swap starts. Not in browser storage: another browser has
none, and a payer who returns after the swap's half hour would land on the
payment methods with the refund off-screen ([Swap
refunds](../guides/swap-refunds.md)).

## Settings

- `NWC_URI`: a receive-only code from your wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
- `DATABASE_URL`: your Postgres. On serverless hosts use the pooled URL.
- Optional: `LSC_URI_PRIMARY` for swaps
  ([set one up](https://openreceive.org/set_up_swap_provider)), and
  `LSC_URI_BACKUP`.

The route reads them from `process.env` when the first request arrives.
`nuxt dev` loads `.env` into `process.env`. In production, set them in the
server's environment: the built server does not read `.env`. Do not copy them
into `runtimeConfig.public`, which goes to the browser.

No worker or cron job is needed. Each request to the payment routes also
checks the wallet for settled invoices, through a lock in your database. A
payer who closes the tab is settled on the next request.

## Next

- To have a coding agent do this, give it the
  [Nuxt agent directions](https://openreceive.org/agent-directions/nuxt.md):
  this recipe in full, plus the steps an agent gets wrong.
