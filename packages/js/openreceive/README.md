# openreceive

Receive-only Lightning payments through a wallet you control.

OpenReceive adds inbound Bitcoin Lightning payments to a website or app. Your
server creates and verifies BOLT11 invoices over a server-side, receive-only
Nostr Wallet Connect (NWC / NIP-47) connection; when a swap provider is
configured, payers can also start from USDT, USDC, ETH, or SOL and have the
payment settle into Bitcoin. OpenReceive is not a custodian or payment
processor: it never transmits money or holds funds, and your app keeps
ownership of orders while the library manages its own `openreceive_payments`
rows in your existing database. No separate database or Redis required.

This package is the umbrella: it re-exports the OpenReceive Node service,
browser helpers, checkout UI, provider data, and generated contracts, and it
installs the `openreceive` CLI.

This package is ESM-only and requires Node >= 22.

## Install

```sh
npm install openreceive
```

Framework adapters and UI wrappers are optional peer packages — add the ones
for your stack:

```sh
npm install @openreceive/express @openreceive/react
# or: @openreceive/fastify, @openreceive/next,
#     @openreceive/vue, @openreceive/svelte, @openreceive/angular
```

## Use

Prefer a subpath for the surface you need:

- `openreceive/node` — server SDK (service, wallet client, pricing)
- `openreceive/http` — framework-neutral checkout HTTP handler
- `openreceive/express` | `openreceive/fastify` | `openreceive/next` — route adapters
- `openreceive/browser` | `openreceive/react` | `openreceive/vue` | `openreceive/svelte` | `openreceive/angular` | `openreceive/elements` — checkout UI
- `openreceive/provider-data` — Lightning provider registry
- `openreceive/contracts` — generated contract constants

```ts
import express from "express";
import { openReceiveExpress } from "openreceive/express";
import { db, orders } from "./app.ts"; // your existing database handle and models

const app = express();
app.use(express.json());
app.use(
  openReceiveExpress({
    nwc: process.env.NWC_URI!, // receive-only NWC code; boot fails closed otherwise
    db,
    loadOrder: (orderId) => orders.find(orderId),
    amountForOrder: (order) => ({ currency: "USD", value: order.total.toString() }),
    onPaid: async ({ orderId, query }) => {
      await query("UPDATE orders SET state = 'paid' WHERE id = ?", [orderId]);
    },
    // Your policy: OpenReceive never inspects sessions, and possession of an
    // order id is not ownership. See docs/guides/authorization.md.
    authorize: ({ native, resource }) =>
      orders.ownedBy(
        (native as { session?: { userId?: string } }).session?.userId,
        resource.order_id,
      ),
  }),
);
```

Scaffold the payments table for your ORM with the bundled CLI:

```sh
npx openreceive scaffold payments --orm prisma   # or drizzle | typeorm | sequelize | knex
```

## Learn more

- [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md)
- [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md)
- [Repository](https://github.com/openreceive/openreceive)
- [openreceive.org](https://openreceive.org)
