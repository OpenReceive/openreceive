# @openreceive/nuxt

Add Bitcoin Lightning checkout to a Nuxt app and receive payments directly
into a wallet you control. Your server creates each invoice, the payment goes
straight to your wallet, and payment attempts are stored in your app's own
database. There is no OpenReceive account and no background worker.

This module mounts the payment routes (`@openreceive/http`) as a Nitro server
route and registers `<OpenReceiveCheckout>`, the `@openreceive/vue` checkout,
with its stylesheet. You write three hooks (`authorize`, `amountFor`,
`onPaid`) and hand over your database handle.

Docs and setup: [openreceive.org/integrations/nuxt](https://openreceive.org/integrations/nuxt)

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

## Install

Requires Node >= 22 and Nuxt 4 on Nitro's `node-server` preset. The wallet
connection and your database driver need Node, so the routes do not run on an
edge preset.

```sh
npm install @openreceive/nuxt pg
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@openreceive/nuxt"],
});
```

Start with the [Nuxt quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-nuxt.md)
and the [payment storage guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/storage.md):
the payment tables go in through your own migrations.

## Your hooks

The module reads them from `server/openreceive.ts`. Nitro's auto-imports work
there as in any server file:

```ts
// server/openreceive.ts
import { defineOpenReceive } from "@openreceive/nuxt/server";

export default defineOpenReceive({
  storage: {
    db, // your pg Pool, node:sqlite or better-sqlite3 handle
    onPaid: async ({ reference, paidAt, query }) => {
      await query(
        "UPDATE orders SET state = 'paid', paid_at = $1 WHERE id = $2 AND state = 'awaiting_payment'",
        [paidAt, reference],
      );
    },
  },
  // The price comes from your order row, never from the request.
  amountFor: async (reference) => {
    const order = await findOrder(reference);
    return order?.state === "awaiting_payment"
      ? { currency: order.currency, value: order.amount, description: order.title }
      : null;
  },
  // `native` is the request's H3Event: read the session your app already has.
  authorize: async ({ native, resource }) => {
    const order = resource.reference ? await findOrder(resource.reference) : undefined;
    return Boolean(order && order.visitor === getCookie(native, "visitor"));
  },
});
```

The routes read `NWC_URI` (and `LSC_URI_PRIMARY` for swaps) from
`process.env` when the first request arrives, so `nuxt build` and
prerendering never connect to the wallet. Keep the codes out of
`runtimeConfig.public`, which goes to the browser.

`onPaid` runs inside the settlement transaction, once per order. Do the order
update through the supplied `query`, and keep it to database writes: send
emails after commit.

## The checkout

```vue
<template>
  <OpenReceiveCheckout :reference="order.id" resumable />
</template>
```

It takes every prop of the `@openreceive/vue` checkout, and its `prefix`
follows the module's.

## Options

```ts
export default defineNuxtConfig({
  modules: ["@openreceive/nuxt"],
  openreceive: {
    prefix: "/openreceive", // where the routes are mounted
    config: "server/openreceive", // the file with your hooks
    css: true, // add @openreceive/vue/styles.css to every page
  },
});
```

Without `server/openreceive.ts`, the module warns and mounts no route.

## Guides

- [Frontend checkout](https://github.com/openreceive/openreceive/blob/master/docs/guides/frontend-checkout.md)
- [Optional swaps](https://github.com/openreceive/openreceive/blob/master/docs/guides/automated-swaps.md)
- [Swap refunds](https://github.com/openreceive/openreceive/blob/master/docs/guides/swap-refunds.md)
- [Rate limiting](https://github.com/openreceive/openreceive/blob/master/docs/guides/rate-limiting.md)
- [Host testing](https://github.com/openreceive/openreceive/blob/master/docs/guides/host-testing.md)

## Agent skills

Run `npx openreceive skills install` from your application. To have a coding
agent do the integration, give it the
[Nuxt agent directions](https://openreceive.org/agent-directions/nuxt.md).
