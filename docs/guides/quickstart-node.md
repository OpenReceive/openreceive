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
store. OpenReceive uses that store for invoice state only; your app keeps
orders, carts, users, and fulfillment state in your own tables.

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

Define routes in the same Express app that owns your checkout:

```ts
// server/index.ts
import express from "express";
import { createOpenReceive } from "@openreceive/node";

const app = express();
app.use(express.json());

const openreceive = await createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderUuid);
  },
});
const or = openreceive.handlers;

app.post("/openreceive/v1/invoices", or.createInvoice);
app.get("/openreceive/v1/invoices/:invoice_id", or.getInvoice);
app.post("/openreceive/v1/invoices/lookup", or.lookupInvoice);
app.post("/openreceive/v1/invoices/:invoice_id/refresh", or.refreshInvoice);
app.get("/openreceive/v1/rates", or.listRates);
app.post("/openreceive/v1/rates/quote", or.quoteRates);
app.get("/openreceive/v1/routes", or.listRoutes);
app.get("/openreceive/v1/providers", or.listProviders);
app.get("/openreceive/v1/health", or.health);
app.get("/openreceive/v1/capabilities", or.capabilities);

app.listen(3000);
```

`/openreceive/v1` is the default base path used by the browser helpers. You can
choose another app path if you pass the same base path to `createOpenReceive`
and the matching frontend helper URLs.

## Next.js App Router

Install the Node package plus your frontend package:

```sh
npm install @openreceive/node @openreceive/browser @openreceive/react
```

Create the catch-all route:

```ts
// app/openreceive/v1/[...openreceive]/route.ts
import { createOpenReceive } from "@openreceive/node";

export const runtime = "nodejs";

const openreceiveReady = createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderUuid);
  },
});

export async function GET(request: Request) {
  const openreceive = await openreceiveReady;
  return openreceive.handleFetch(request);
}

export async function POST(request: Request) {
  const openreceive = await openreceiveReady;
  return openreceive.handleFetch(request);
}
```

Next.js App Router expects one exported function per HTTP method. Both
functions delegate to OpenReceive. Put this route file wherever your app keeps
checkout route handlers.

## Fastify

Install Fastify and the Node package:

```sh
npm install fastify @openreceive/node
```

Define the same routes in your Fastify app:

```ts
// server/index.ts
import Fastify from "fastify";
import { createOpenReceive } from "@openreceive/node";

const app = Fastify();

const openreceive = await createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderUuid);
  },
});

async function openReceiveRoute(request, reply) {
  await openreceive.handleNode(request.raw, reply.raw);
  reply.hijack();
}

app.post("/openreceive/v1/invoices", openReceiveRoute);
app.get("/openreceive/v1/invoices/:invoice_id", openReceiveRoute);
app.post("/openreceive/v1/invoices/lookup", openReceiveRoute);
app.post("/openreceive/v1/invoices/:invoice_id/refresh", openReceiveRoute);
app.get("/openreceive/v1/rates", openReceiveRoute);
app.post("/openreceive/v1/rates/quote", openReceiveRoute);
app.get("/openreceive/v1/routes", openReceiveRoute);
app.get("/openreceive/v1/providers", openReceiveRoute);
app.get("/openreceive/v1/health", openReceiveRoute);
app.get("/openreceive/v1/capabilities", openReceiveRoute);

await app.listen({ port: 3000 });
```

## Browser Helper

Install the browser package in your frontend app:

```sh
npm install @openreceive/browser
```

Create an invoice from a stable app order UUID:

```ts
import { createInvoice } from "@openreceive/browser";

const invoice = await createInvoice({
  orderUuid,
  fiat: { currency: "USD", value: "10.00" },
  optionalInvoiceDescription: "Order #1234",
});
```

Use exactly one amount source:

```ts
await createInvoice({
  orderUuid,
  amountInSatoshis: 500,
  optionalInvoiceDescription: "Order #1234",
});
```

Reusing the same `orderUuid` with the same request replays the existing invoice.
Reusing it with a different amount or description returns a conflict.

## React

```sh
npm install @openreceive/browser @openreceive/react
```

```tsx
import { createInvoice } from "@openreceive/browser";
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

const invoice = await createInvoice({
  orderUuid,
  fiat: { currency: "USD", value: "10.00" },
  optionalInvoiceDescription: "Order #1234",
});

<Checkout invoice={invoice} onPaid={() => showThankYou()} />;
```

`onPaid` is a UI hint. Unlock the order from the server `onPaid` hook.

## Vue

```sh
npm install @openreceive/browser @openreceive/vue
```

```vue
<script setup lang="ts">
import { createInvoice } from "@openreceive/browser";
import Checkout from "@openreceive/vue/checkout.vue";
import "@openreceive/vue/styles.css";

const invoice = await createInvoice({
  orderUuid,
  fiat: { currency: "USD", value: "10.00" },
  optionalInvoiceDescription: "Order #1234",
});
</script>

<template>
  <Checkout :snapshot="invoice" :options="{ onSettled: showThankYou }" />
</template>
```

## Svelte

```sh
npm install @openreceive/browser @openreceive/svelte
```

```svelte
<script lang="ts">
  import { createInvoice } from "@openreceive/browser";
  import Checkout from "@openreceive/svelte/checkout.svelte";
  import "@openreceive/svelte/styles.css";

  const invoice = await createInvoice({
    orderUuid,
    fiat: { currency: "USD", value: "10.00" },
    optionalInvoiceDescription: "Order #1234"
  });
</script>

<Checkout snapshot={invoice} options={{ onSettled: showThankYou }} />
```

## Optional Scheduler

Browser payment-status checks are enough for the normal checkout path. For
extra recovery after visitors close the page, see
[Optional Scheduler](optional-scheduler.md) for platform-specific examples.
