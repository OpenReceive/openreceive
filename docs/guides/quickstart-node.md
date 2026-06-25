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
store. For production, use OpenReceive-managed Postgres or SQLite invoice
storage.
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

When you create an invoice from a fiat order total, pass both the decimal value
and its server-side currency code, for example
`{ currency: "USD", value: "0.25" }`. `fiat.currency` must be one of the
`priceCurrencies` configured on `createOpenReceive`; do not infer it from
browser locale or a global env var.

For Bitcoin-denominated products, skip price feeds and pass a direct amount:
`{ amount: { currency: "BTC", value: "0.005" } }` or
`{ amount: { currency: "SATS", value: "7000" } }`. OpenReceive converts those
amounts with integer math and never asks a BTC fiat price provider for `BTC` or
`SATS`.

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
import { createOpenReceive } from "@openreceive/node";

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
    // Your app function. Create and validate the order before calling OpenReceive.
    const order = await createOrderFromCart(req.user, req.body.cart);
    const invoice = await openreceive.createInvoice({
      orderUuid: order.uuid,
      fiat: {
        currency: order.totalAmount.currency,
        value: order.totalAmount.value
      },
      optionalInvoiceDescription: `Order ${order.number}`,
      expiry: 600
    });

    res.status(201).json({ order, invoice });
  } catch (error) {
    sendCheckoutError(res, next, error);
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
    sendCheckoutError(res, next, error);
  }
});

function sendCheckoutError(res, next, error) {
  if (isCheckoutHttpError(error)) {
    res.status(error.status).json(error.body);
    return;
  }
  next(error);
}

function isCheckoutHttpError(error) {
  return typeof error === "object" &&
    error !== null &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599 &&
    typeof error.body === "object" &&
    error.body !== null;
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
import { createOpenReceive } from "@openreceive/node";

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
    // Your app function. Create and validate the order before calling OpenReceive.
    const order = await createOrderFromCart(body.cart);
    const invoice = await openreceive.createInvoice({
      orderUuid: order.uuid,
      fiat: {
        currency: order.totalAmount.currency,
        value: order.totalAmount.value
      },
      optionalInvoiceDescription: `Order ${order.number}`,
      expiry: 600
    });

    return Response.json(
      { order, invoice },
      { status: 201 }
    );
  } catch (error) {
    const response = checkoutErrorResponse(error);
    if (response !== undefined) return response;
    throw error;
  }
}

function checkoutErrorResponse(error: unknown): Response | undefined {
  if (!isCheckoutHttpError(error)) return undefined;
  return Response.json(error.body, { status: error.status });
}

function isCheckoutHttpError(error: unknown): error is {
  readonly status: number;
  readonly body: Record<string, unknown>;
} {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly status?: unknown; readonly body?: unknown };
  return Number.isInteger(candidate.status) &&
    typeof candidate.status === "number" &&
    candidate.status >= 400 &&
    candidate.status <= 599 &&
    typeof candidate.body === "object" &&
    candidate.body !== null &&
    !Array.isArray(candidate.body);
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
import { createOpenReceive } from "@openreceive/node";

const app = Fastify();

const openreceive = await createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderUuid);
  },
});

function sendCheckoutError(reply, error) {
  if (isCheckoutHttpError(error)) {
    reply.code(error.status).send(error.body);
    return true;
  }
  return false;
}

function isCheckoutHttpError(error) {
  return typeof error === "object" &&
    error !== null &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599 &&
    typeof error.body === "object" &&
    error.body !== null;
}

app.post("/create_order", async (request, reply) => {
  try {
    // Your app function. Create and validate the order before calling OpenReceive.
    const order = await createOrderFromCart(request.body.cart);
    const invoice = await openreceive.createInvoice({
      orderUuid: order.uuid,
      fiat: {
        currency: order.totalAmount.currency,
        value: order.totalAmount.value
      },
      optionalInvoiceDescription: `Order ${order.number}`,
      expiry: 600
    });
    reply.code(201).send({ order, invoice });
  } catch (error) {
    if (!sendCheckoutError(reply, error)) throw error;
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
    if (!sendCheckoutError(reply, error)) throw error;
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

Your backend should use a stable order UUID as the OpenReceive `orderUuid`.
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
If your app only wants QR/copy/provider guidance and has no frontend status
route, render the checkout without polling:

```tsx
<Checkout invoice={invoice} polling={false} />;
```

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

## Angular

```sh
npm install @openreceive/browser @openreceive/angular @angular/core
```

Angular apps can use the package's standalone checkout component:

```ts
import { Component } from "@angular/core";
import { CheckoutComponent } from "@openreceive/angular/checkout-component";
import "@openreceive/angular/styles.css";

@Component({
  selector: "app-checkout",
  standalone: true,
  imports: [CheckoutComponent],
  template: `
    <openreceive-angular-checkout
      [snapshot]="invoice"
      [options]="{
        lookupUrl: '/order_status',
        onSettled: showThankYou
      }"
    />
  `
})
export class AppCheckoutComponent {
  invoice;
  showThankYou = () => {
    // UI hint only. Unlock from the server onPaid hook.
  };
}
```

## Optional Scheduler

Browser payment-status checks are enough for the normal checkout path. For
extra recovery after visitors close the page, see
[Optional Scheduler](optional-scheduler.md) for platform-specific examples.
