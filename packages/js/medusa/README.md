# @openreceive/medusa

Take Bitcoin Lightning payments in [Medusa](https://medusajs.com), straight
into your own wallet. The buyer pays at the storefront's checkout, and the
order is placed once the payment settles.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

Medusa keeps carts, orders, prices and customers. The plugin keeps payment
attempts in two tables of Medusa's own database, and a settled payment is
captured and its cart completed through Medusa's own process-payment
workflow, even when the buyer has left the page.

Docs and setup: [Medusa quickstart](https://openreceive.org/guides/quickstart-medusa)

## Install

Requires Medusa 2 on Node 22.12 or later, with Medusa's PostgreSQL database.
This package is ESM-only.

```sh
npm install @openreceive/medusa
```

In `medusa-config.ts`:

```ts
plugins: [{ resolve: "@openreceive/medusa", options: {} }],
modules: [
  {
    resolve: "@medusajs/medusa/payment",
    options: {
      providers: [{ resolve: "@openreceive/medusa/providers/openreceive", id: "openreceive" }],
    },
  },
],
```

Then, with `NWC_URI` (and optionally `LSC_URI_PRIMARY`) in the Medusa server's
`.env`:

```sh
npx medusa db:migrate
npx medusa exec ./node_modules/@openreceive/medusa/dist/enable-openreceive.js
npx openreceive doctor
```

`db:migrate` creates the two tables, the `exec` script offers the provider
(`pp_openreceive_openreceive`) in every region, and `doctor` checks the codes
and the wallet. The storefront shows the checkout from `@openreceive/react`;
the quickstart has the code for Medusa's Next.js starter.

## What the plugin adds

- A payment provider: a session is captured once its payment settles in the
  wallet, and Medusa refuses to complete the cart before that. A refund made
  in the admin is recorded only; send it from your own wallet.
- The checkout's routes under `/store/openreceive`, behind Medusa's
  publishable API key.
- A job every minute that finds a payment whose buyer left the page and has
  Medusa place the order.
- A migration script that creates `openreceive_payments` and
  `openreceive_meta`.

Part of [OpenReceive](https://openreceive.org). MIT licensed.
