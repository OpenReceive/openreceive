# Node quickstart

Get Express + React receiving Lightning payments. Fastify and Next.js use the same host
hooks; swap `@openreceive/express` for `@openreceive/fastify` or `@openreceive/next`.

## 1. Install

```sh
npm install @openreceive/node @openreceive/http @openreceive/express express
npm install @openreceive/react
```

Other frontends: `@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular`, or
`@openreceive/elements`.

## 2. Scaffold the payment model

```sh
npx openreceive scaffold payments
```

Or non-interactive:

```sh
npx openreceive scaffold payments --orm prisma
```

Follow the generated `OPENRECEIVE_PAYMENTS.md`, then fill `loadOrder` and `amountForOrder`.
Manual recipes: [Node ORM Recipes](node-orms.md).

## 3. Add wallet credentials

Create a server-only `.env`:

```dotenv
NWC_URI=
LSC_URI_PRIMARY=
LSC_URI_BACKUP=
```

1. Get a receive-only NWC code from
   [Get an NWC code](https://openreceive.org/get_a_nwc_code_to_receive_payments)
   → `NWC_URI`.
2. Optionally set a swap provider from
   [Set up a swap provider](https://openreceive.org/set_up_swap_provider)
   → `LSC_URI_PRIMARY` (and `LSC_URI_BACKUP` if you have one).

Never put these values in browser code.

## 4. Create orders in your app

Validate the cart, price with exact decimal math, persist the order, return its ID:

```ts
app.post("/orders", async (request, response, next) => {
  try {
    const viewer = await requireCurrentUser(request);
    const cart = await validateCartAgainstCatalog(request.body);
    const order = await orders.create({
      userId: viewer.id,
      currency: "USD",
      total: cart.totalUsd,
    });

    response.status(201).json({ order_id: order.id });
  } catch (error) {
    next(error);
  }
});
```

## 5. Wire OpenReceive

```ts
import express from "express";
import { createOpenReceive } from "@openreceive/node";
import { createOpenReceivePaymentHooks } from "@openreceive/http";
import { openReceiveExpress } from "@openreceive/express";
import type { OpenReceiveAuthorize } from "@openreceive/http";

const service = await createOpenReceive({
  onPaid: async ({ paymentHash, paidAt }) => {
    await payments.markPaidOnce({ paymentHash, paidAt });
  },
});

const authorize: OpenReceiveAuthorize = async ({ action, request, resource }) => {
  const orderId = resource.order_id;
  if (!orderId) return false;
  const viewer = await sessions.currentUser(request);
  if (!viewer) return false;
  return orders.userMayPerform({ userId: viewer.id, orderId, action });
};

const { resolveCheckout, onCheckoutCreated } = createOpenReceivePaymentHooks({
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => ({
    currency: order.currency,
    value: order.total.toString(),
  }),
  payments: paymentRepository,
});

const app = express();
app.use(express.json());
app.use(
  openReceiveExpress({
    service,
    authorize,
    resolveCheckout,
    onCheckoutCreated,
  }),
);
```

`paymentRepository` comes from the scaffolder. `markPaidOnce` must be idempotent —
`onPaid` can fire more than once.

## 6. Render checkout

```ts
const response = await fetch("/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cart }),
});
const { order_id } = await response.json();
```

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout orderId={order_id} prefix="/openreceive" />;
```

## 7. Verify

```sh
npx openreceive doctor
```

Run your normal ORM migrations. OpenReceive itself takes no database URL.

## Next

- [Authorization](authorization.md) — host policy boundary
- [Frontend Checkout](frontend-checkout.md) — browser responsibilities
- [Automated Swaps](automated-swaps.md) — `swap_data` and refunds
- [Node ORM Recipes](node-orms.md) — manual payment-attempt wiring
- [Security](security.md) — server-only secret boundaries

For request flow, retries/concurrency, and direct server checkout, see
[Node integration details](../internal/node-integration.md).
