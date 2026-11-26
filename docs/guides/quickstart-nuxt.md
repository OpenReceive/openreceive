# Nuxt quickstart

Nuxt 4 + Vue, with the `@openreceive/nuxt` module. Your server code creates
each Lightning invoice, the payment goes straight to your wallet, and payment
attempts are stored in your app's database. There is no OpenReceive account
and no background worker. Requires Node ≥ 22 and Nuxt 4 on Nitro's
`node-server` preset.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

The module registers what you would otherwise write by hand: one server route
for every payment path under `/openreceive/`, and `<OpenReceiveCheckout>`, the
`@openreceive/vue` checkout with its stylesheet. You write three hooks in
`server/openreceive.ts` and the checkout page.

`@openreceive/nuxt` is tested on Nuxt 4.7 (Nitro 2, h3 1.15) in a built app
run as `node .output/server/index.mjs`, on SQLite, with a test wallet on a
local relay. In Chromium, the buyer's checkout page started the checkout once,
under the module's prefix, both after a client-side navigation and on a
direct load. A stranger got 403 from the payment routes and 404 from the page,
and a request that named its own amount got 400. When the wallet marked the
invoice paid, `onPaid` marked the order paid.

## 1. Install

```sh
npm install @openreceive/nuxt pg
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@openreceive/nuxt"],
});
```

`pg` is for Postgres. With SQLite you need no driver package: `node:sqlite`
comes with Node 22.13 and newer. The wallet client, the HTTP handler and the
Vue checkout come along as dependencies of the module. The `openreceive`
package is only the CLI, and `npx openreceive …` below needs no install.

The module's options, all optional:

```ts
export default defineNuxtConfig({
  modules: ["@openreceive/nuxt"],
  openreceive: {
    prefix: "/openreceive", // where the payment routes are mounted
    config: "server/openreceive", // the file with your hooks
    css: true, // add @openreceive/vue/styles.css to every page
  },
});
```

`<OpenReceiveCheckout>` uses the same `prefix`, so the page and the routes
cannot disagree.

## Where it runs

On Node, with Nitro's default `node-server` preset. The wallet connection and
your database driver need Node, so the routes cannot run on an edge runtime.
The Vercel, Netlify and AWS Lambda presets deploy Node functions: read
[Bitcoin checkout on serverless hosts](serverless.md) first. For Cloudflare
Workers, the [TanStack Start recipe](../recipes/tanstack-start.md#where-it-runs)
explains what a Worker needs. The module was not run on those hosts.

## 2. Your database

`db` is a `pg` Pool, `node:sqlite` or `better-sqlite3`, or one of the
adapters in [Node ORM recipes](node-orms.md). With Drizzle, pass the `pg`
Pool underneath it.

Create OpenReceive's two tables with your migrations
(`npx openreceive scaffold payments --orm <your orm>`), or run
`paymentsSchemaSql("postgres")` from `@openreceive/http` once. It is
idempotent. The module pulls that package in, but this import is yours, so
install it too: `npm install @openreceive/http`. See
[Payment storage](storage.md).

## 3. Credentials

<!-- shared:begin credentials -->
```dotenv
NWC_URI=
LSC_URI_PRIMARY=
LSC_URI_BACKUP=
```

1. Get a receive-only NWC code from a compatible wallet
   ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
   Put it in `NWC_URI`.
2. Optional: set up a [swap provider](https://openreceive.org/set_up_swap_provider).
   Put its connection string in `LSC_URI_PRIMARY`, and a second one in
   `LSC_URI_BACKUP` if you have one.

Never put these values in browser code. Your app refuses to start if the NWC
code also advertises spend methods such as `pay_invoice`. Create a
receive-only code instead ([Security](security.md)).
<!-- shared:end credentials -->

Add `DATABASE_URL` for your Postgres; on serverless hosts use the pooled URL.

The routes read the codes from `process.env` when the first request arrives.
`nuxt dev` loads `.env` into `process.env`. The built server does not: start
it with `node --env-file=.env .output/server/index.mjs`, or set the variables
in the server's environment. Do not copy them into `runtimeConfig.public`, or
a `NUXT_PUBLIC_` variable, which go to the browser.

## 4. Your hooks

The module reads them from `server/openreceive.ts`. Nuxt auto-imports the h3
helpers and everything in `server/utils/` there, as in any server file:

```ts
// server/openreceive.ts
import { defineOpenReceive } from "@openreceive/nuxt/server";

export default defineOpenReceive({
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
    const order = resource.reference ? await findOrder(resource.reference) : undefined;
    return Boolean(order && order.visitor === getCookie(native, "visitor"));
  },
  // 60 new invoices an hour per client IP, counted in your database.
  rateLimiting: true,
});
```

`native` is the request's `H3Event`, so `authorize` can check the session your
app already has: its cookies, or the user your session module reads from the
event. The [Next.js quickstart](quickstart-next.md) explains each hook. They
are the same here.

The payment routes are built on the first request, not at import, so the build
and prerendering never connect to the wallet, and one set serves the whole
server process. `rateLimiting` counts the socket address. Behind your own
reverse proxy, add `trustProxyIpHeader: true` to read the first address in
`x-forwarded-for`, which is safe only when that proxy sets the header
([Rate limiting](rate-limiting.md)).

Until `server/openreceive.ts` exists, the module warns and mounts no route.

## 5. The checkout page

The order's own page renders the checkout:

```vue
<!-- app/pages/checkout/[reference].vue -->
<script setup lang="ts">
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
  <OpenReceiveCheckout v-if="data" :reference="data.reference" resumable
    :resume-payment-hash="data.swapPaymentHash" :on-state="onState" />
</template>
```

It asks your own server route whether this visitor owns the order:

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

`<OpenReceiveCheckout>` needs no import and no stylesheet import: the module
registers both. It takes every prop of the `@openreceive/vue` checkout
([Frontend checkout](frontend-checkout.md)). The page renders on the server
and starts the checkout in the browser. The payer picks Bitcoin and gets the
invoice.

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
refunds](swap-refunds.md)).

No worker or cron job is required. Each request to the payment routes also
checks the wallet for settled invoices, through a lock in your database. A
payer who closes the tab is settled on the next request from anyone.
On a quiet site that can be hours later. If fulfillment should not wait, see
[When the payer leaves the page](deploying.md#when-the-payer-leaves-the-page).

## 6. Verify

```sh
npx openreceive doctor --db "$DATABASE_URL" --url http://localhost:3000
```

`openreceive doctor` reads `.env`, checks `NWC_URI` and the swap-provider
configuration, and probes the wallet relay to confirm the code is
receive-only. `--db` confirms the payment tables exist, and `--url` that the
routes are mounted. Every failing line states its own fix. After a production
build, `npx openreceive doctor --scan-build .output/public` confirms no code
reached the browser files.

Then open an order's checkout page in a browser. Confirm the payment-method
icons and wallet logos render, and open a wallet's pay tutorial to check its
screenshots.

<!-- shared:begin next -->
## Next

- [Authorization](authorization.md) — your policy boundary
- [Payment storage](storage.md) — the table the library owns, and its state machine
- [Frontend Checkout](frontend-checkout.md) — what the browser side is responsible for
- [Automated Swaps](automated-swaps.md) — `swap_data`, and what turning swaps on commits you to
- [Swap refunds](swap-refunds.md) — the refund flow, and the per-order URL a payer needs to come back and claim a refund. Read it before you set `LSC_URI_PRIMARY`
- [Security](security.md) — which secrets must stay on the server

More on wiring, storage, and routes:
[Authorization](authorization.md), [Payment storage](storage.md),
[API reference](api-reference.md).
<!-- shared:end next -->

To have a coding agent do this, give it the
[Nuxt agent directions](https://openreceive.org/agent-directions/nuxt.md):
this quickstart in full, plus the steps an agent gets wrong.
