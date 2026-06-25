# Node Framework Quickstart

OpenReceive runs inside your app. When funds arrive, OpenReceive calls your
`onPaid` hook with your unique `orderUuid`.

## Environment

All you need to start is a receive-only NWC code from any NWC provider, or one
you build yourself. Details:
[Get a NWC code to receive payments](https://openreceive.org/get_a_nwc_code_to_receive_payments).
Set the receive-only NWC code only in your server environment:

```sh
OPENRECEIVE_NWC=nostr+walletconnect://...
```

Storage is optional during setup. If `OPENRECEIVE_STORE` is omitted,
OpenReceive uses `local-sqlite` and creates
`./.openreceive/<namespace>.sqlite3`.

```sh
# Optional. Defaults to local-sqlite.
OPENRECEIVE_STORE=postgres://user:pass@host:5432/appdb

# Optional. Defaults to default.
OPENRECEIVE_NAMESPACE=my_app
```

The default SQLite file is fine for one local server. If more than one server,
worker, serverless instance, or scheduler can touch the same
`OPENRECEIVE_NAMESPACE`, point all of them at one shared durable OpenReceive
store. For production, use a package-owned Postgres or SQLite invoice store.
OpenReceive uses that store for invoice state only; your app keeps orders,
carts, users, and fulfillment state in your own tables.

Start the server only after `OPENRECEIVE_NWC` is set for that environment.
For local setup, the default SQLite store is enough. For shared production
deployments, set `OPENRECEIVE_STORE` before checkout traffic reaches customers.

## Server Object

Each server example creates one server-only OpenReceive object:

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderUuid);
  },
});
```

OpenReceive calls `onPaid` after payment is verified. The hook can run more
than once. `orderUuid` is guaranteed to be the unique app order key for this
checkout, so use it for idempotent fulfillment. Most apps can ignore the invoice
details in this hook; they are available only when you want extra audit or
correlation data.

## Express

Install Express, the Node package, and your frontend packages:

```sh
npm install express @openreceive/node @openreceive/browser @openreceive/react
```

Define routes in the same Express app that owns your checkout. Your app creates
the order, computes the trusted total, calls OpenReceive to create the invoice,
and returns both order and display-safe invoice data:

```ts
// server/index.ts
import express from "express";
import {
  OpenReceiveServiceError,
  createOpenReceive
} from "@openreceive/node";

const app = express();
app.use(express.json());

const openreceive = await createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderUuid);
  },
});

app.post("/create_order", async (req, res, next) => {
  try {
    const order = await createOrderFromCart(req.user, req.body.cart);
    const invoice = await openreceive.createInvoice({
      order_uuid: order.uuid,
      fiat: order.total_fiat,
      optional_invoice_description: `Order ${order.number}`,
      expiry: 600
    });

    res.status(201).json({ order, invoice });
  } catch (error) {
    sendOpenReceiveError(res, next, error);
  }
});

app.post("/order_status", async (req, res, next) => {
  try {
    const invoice = await openreceive.lookupInvoice({
      payment_hash: req.body.payment_hash
    });

    res.status(200).json({
      ...invoice,
      order_status: invoice.settled_at || invoice.transaction_state === "settled"
        ? "paid"
        : "pending_payment"
    });
  } catch (error) {
    sendOpenReceiveError(res, next, error);
  }
});

function sendOpenReceiveError(res, next, error) {
  if (error instanceof OpenReceiveServiceError) {
    res.status(error.status).json(error.body);
    return;
  }
  next(error);
}

app.listen(3000);
```

Use your normal route names, sessions, CSRF, CORS, and authorization. The
browser posts carts to your app route and renders `response.invoice`.

## Next.js App Router

Install the Node package plus your frontend package:

```sh
npm install @openreceive/node @openreceive/browser @openreceive/react
```

Create normal app route handlers and call the same service methods from your
order controller:

```ts
// app/create_order/route.ts
import {
  OpenReceiveServiceError,
  createOpenReceive
} from "@openreceive/node";

export const runtime = "nodejs";

const openreceiveReady = createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderUuid);
  },
});

export async function POST(request: Request) {
  const openreceive = await openreceiveReady;
  try {
    const body = await request.json();
    const order = await createOrderFromCart(body.cart);
    const invoice = await openreceive.createInvoice({
      order_uuid: order.uuid,
      fiat: order.total_fiat,
      optional_invoice_description: `Order ${order.number}`,
      expiry: 600
    });

    return Response.json(
      { order, invoice },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      return Response.json(error.body, { status: error.status });
    }
    throw error;
  }
}
```

Add a sibling `app/order_status/route.ts` that calls
`openreceive.lookupInvoice({ payment_hash })` and returns your app's order
status plus the display-safe invoice fields.

## Fastify

Install Fastify and the Node package:

```sh
npm install fastify @openreceive/node
```

Define your checkout routes in Fastify and call OpenReceive methods inside your
app's order actions:

```ts
// server/index.ts
import Fastify from "fastify";
import {
  OpenReceiveServiceError,
  createOpenReceive
} from "@openreceive/node";

const app = Fastify();

const openreceive = await createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderUuid);
  },
});

function sendOpenReceiveError(reply, error) {
  if (error instanceof OpenReceiveServiceError) {
    reply.code(error.status).send(error.body);
    return true;
  }
  return false;
}

app.post("/create_order", async (request, reply) => {
  try {
    const order = await createOrderFromCart(request.body.cart);
    const invoice = await openreceive.createInvoice({
      order_uuid: order.uuid,
      fiat: order.total_fiat,
      optional_invoice_description: `Order ${order.number}`,
      expiry: 600
    });
    reply.code(201).send({ order, invoice });
  } catch (error) {
    if (!sendOpenReceiveError(reply, error)) throw error;
  }
});

app.post("/order_status", async (request, reply) => {
  try {
    const invoice = await openreceive.lookupInvoice({
      payment_hash: request.body.payment_hash
    });
    reply.send({
      ...invoice,
      order_status: invoice.settled_at || invoice.transaction_state === "settled"
        ? "paid"
        : "pending_payment"
    });
  } catch (error) {
    if (!sendOpenReceiveError(reply, error)) throw error;
  }
});

await app.listen({ port: 3000 });
```

## Browser Helper

Install the browser package in your frontend app:

```sh
npm install @openreceive/browser
```

Create an order through your app and keep the invoice data returned by the
server:

```ts
const response = await fetch("/create_order", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cart })
});

const { order, invoice } = await response.json();
```

Your backend should use a stable order UUID as the OpenReceive `order_uuid`.
Reusing the same order UUID with the same invoice request replays the existing
invoice. Reusing it with a different amount or description returns a conflict.

## React

```sh
npm install @openreceive/browser @openreceive/react
```

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

const response = await fetch("/create_order", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cart })
});
const { invoice } = await response.json();

<Checkout
  invoice={invoice}
  lookupUrl="/order_status"
  onPaid={() => showThankYou()}
/>;
```

`onPaid` is a UI hint. Unlock the order from the server `onPaid` hook.

## Vue

```sh
npm install @openreceive/browser @openreceive/vue
```

```vue
<script setup lang="ts">
import Checkout from "@openreceive/vue/checkout.vue";
import "@openreceive/vue/styles.css";

const response = await fetch("/create_order", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cart })
});
const { invoice } = await response.json();
</script>

<template>
  <Checkout
    :snapshot="invoice"
    :options="{ lookupUrl: '/order_status', onSettled: showThankYou }"
  />
</template>
```

## Svelte

```sh
npm install @openreceive/browser @openreceive/svelte
```

```svelte
<script lang="ts">
  import Checkout from "@openreceive/svelte/checkout.svelte";
  import "@openreceive/svelte/styles.css";

  const response = await fetch("/create_order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cart })
  });
  const { invoice } = await response.json();
</script>

<Checkout
  snapshot={invoice}
  options={{ lookupUrl: "/order_status", onSettled: showThankYou }}
/>
```

## Optional Scheduler

Browser payment-status checks are enough for the normal checkout path. For
extra recovery after visitors close the page, see
[Optional Scheduler](optional-scheduler.md) for platform-specific examples.
