# Node Framework Quickstart

OpenReceive runs inside your app. Your server owns the receive-only NWC,
creates invoices, stores invoice state, and decides settlement from backend
`lookup_invoice`. The browser only receives display-safe invoice data.

## Environment

Set the wallet secret only in your server environment:

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

Use Postgres when more than one server process can create or settle invoices.
OpenReceive owns only its package-owned Postgres or SQLite invoice store; your
app keeps orders, carts, users, and fulfillment state in your own tables.

`createOpenReceive()` fails at boot if `OPENRECEIVE_NWC` is missing,
malformed, unavailable, or advertises send-payment methods. It also initializes
supported storage before serving routes.

## Server Object

Create one server-only OpenReceive object:

```ts
// server/openreceive.ts
import { createOpenReceive } from "@openreceive/node";

export const openreceive = await createOpenReceive({
  onPaid: async ({ orderUuid, invoice }) => {
    await markOrderPaid({
      orderUuid,
      invoiceId: invoice.invoice_id,
      paymentHash: invoice.payment_hash
    });
  }
});
```

`onPaid` runs after backend-verified settlement and is delivered at least once.
Make fulfillment idempotent by `orderUuid`, `payment_hash`, or invoice id.

OpenReceive does not implement your authentication, session, CSRF, or CORS
policy. Put OpenReceive handlers inside routes/controllers already protected by
your app when checkout should not be public.

## Express

Install the server package and your framework dependencies:

```sh
npm install @openreceive/node express pg
```

Mount the routes in the same Express app that owns your checkout:

```ts
// server/index.ts
import express from "express";
import { openreceive } from "./openreceive";

const app = express();
app.use(express.json());

app.use("/openreceive/v1", requireCheckoutAccess);
openreceive.mountExpress(app);

app.listen(3000);
```

If your checkout is public guest checkout, omit `requireCheckoutAccess` and keep
fulfillment in the server `onPaid` hook.

## Next.js App Router

Install the Node package plus your frontend package:

```sh
npm install @openreceive/node @openreceive/browser @openreceive/react pg
```

Create the catch-all route:

```ts
// app/openreceive/v1/[...openreceive]/route.ts
import { openreceive } from "@/server/openreceive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(request: Request) {
  await requireCheckoutAccess(request);
  return openreceive.handleFetch(request);
}

export const GET = handle;
export const POST = handle;
```

Remove `requireCheckoutAccess(request)` for public guest checkout.

## Fastify

Install Fastify and the Node package:

```sh
npm install @openreceive/node fastify pg
```

Forward the matching Node request/response objects:

```ts
// server/index.ts
import Fastify from "fastify";
import { openreceive } from "./openreceive";

const app = Fastify();

app.addHook("preHandler", async (request) => {
  if (request.url.startsWith("/openreceive/v1/")) {
    await requireCheckoutAccess(request);
  }
});

app.all("/openreceive/v1/*", async (request, reply) => {
  await openreceive.handleNode(request.raw, reply.raw);
  reply.hijack();
});

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
  optionalInvoiceDescription: "Order #1234"
});
```

Use exactly one amount source:

```ts
await createInvoice({
  orderUuid,
  amountInSatoshis: 500,
  optionalInvoiceDescription: "Order #1234"
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
  optionalInvoiceDescription: "Order #1234"
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
  optionalInvoiceDescription: "Order #1234"
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

Browser lookup is enough for the normal checkout path. For extra recovery after
visitors close the page, see
[Optional Scheduler](optional-scheduler.md) for platform-specific examples.
