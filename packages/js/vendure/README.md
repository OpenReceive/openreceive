# @openreceive/vendure

Take Bitcoin Lightning payments in [Vendure](https://vendure.io), straight
into your own wallet. The buyer pays at the storefront's checkout, and Vendure
places the order once the payment settles.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

Vendure keeps orders, prices, customers and fulfillment. The plugin keeps
payment attempts in two tables of Vendure's own database, over Vendure's own
connection. A settled payment is added to its order as a settled Vendure
payment, with the Lightning payment hash as its transaction id, and Vendure
places the order, even when the buyer has left the page.

Docs and setup: [Vendure quickstart](https://openreceive.org/guides/quickstart-vendure)

## Install

Requires Vendure 3.3 or later on Node 22.12 or later, with PostgreSQL, MySQL
or MariaDB (not SQLite), and the worker running with `DefaultSchedulerPlugin`.
This package is ESM-only; a CommonJS Vendure project loads it with Node's
`require()`.

```sh
npm install @openreceive/vendure
```

In `src/vendure-config.ts`:

```ts
import { OpenReceivePlugin } from "@openreceive/vendure/plugin";

plugins: [
  // …your plugins
  OpenReceivePlugin,
],
```

Then, with `NWC_URI` (and optionally `LSC_URI_PRIMARY`) in the Vendure
server's `.env`, restart the server and the worker, and in the server's
project, while it runs:

```sh
node node_modules/@openreceive/vendure/dist/enable-openreceive.js
npx openreceive doctor
```

The server's startup migrations create the two tables, the script creates
the payment method (code `openreceive`) in the default channel, and `doctor`
checks the codes and the wallet. The storefront shows the checkout from
`@openreceive/react`; the quickstart has the code for Vendure's Next.js
starter.

## What the plugin adds

- A payment method handler, `openreceive`. Only the plugin adds its
  payments: the Shop API's `addPaymentToOrder` cannot. A refund made in the
  dashboard stays pending; send it from your own wallet.
- The checkout's routes under `/openreceive` on the Vendure server, behind
  the buyer's Vendure session. `POST /openreceive/order` starts paying the
  session's active order and answers its reference.
- A scheduled task every minute, on the worker, that finds a payment whose
  buyer left the page and places its order.
- A migration that creates `openreceive_payments` and `openreceive_meta`.

Part of [OpenReceive](https://openreceive.org). MIT licensed.
