# App Route Protection

Prefer mounting OpenReceive's shipped routes (see [Shipped Routes](routes.md) and the
[Node](quickstart-node.md) / [Rails](quickstart-rails.md) quickstarts). With that path,
OpenReceive owns create/status/swap HTTP; your app keeps auth via `authorize` and pricing
via the required `resolveOrder` hook. You never hand-write payment endpoints.

This page covers the **advanced** path: calling `createOpenReceive()` service methods from
your own controllers (for example when you create a checkout server-side and pass the
snapshot into `<Checkout checkout={…} />`). Amounts you pass to `getOrCreateCheckout` are
trusted because they come from your server, not from the public create-checkout HTTP body.

## Express (direct service methods)

```ts
import express from "express";
import { createOpenReceive, OpenReceiveServiceError } from "@openreceive/node";

const checkoutRoutes = express.Router();
checkoutRoutes.use(express.json());

const openreceive = await createOpenReceive({
  onPaid: async ({ orderId }) => {
    await markOrderPaidInYourApp(orderId);
  }
});

// Your app's order route — not OpenReceive's create-checkout HTTP body.
checkoutRoutes.post("/create_order", async (req, res, next) => {
  try {
    const order = await createOrderFromCart(req.user, req.body.cart);
    const checkout = await openreceive.getOrCreateCheckout({
      orderId: order.uuid,
      usd: order.total_amount.value,
      memo: `Order ${order.number}`
    });
    res.status(201).json({ order, checkout });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      res.status(error.status).json(error.body);
      return;
    }
    next(error);
  }
});

checkoutRoutes.post("/order", async (req, res, next) => {
  try {
    // Authorize the caller for req.body.order_id here (session or ownership
    // check) before forwarding. order_id is an identifier, not a capability.
    res.json(await openreceive.order(req.body));
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      res.status(error.status).json(error.body);
      return;
    }
    next(error);
  }
});
```

Mount `checkoutRoutes` wherever your app already mounts checkout controllers. For the
recommended mounted-router path, use `openReceiveExpress({ service, resolveOrder, authorize })`
instead — see [Shipped Routes](routes.md).

## Next.js (direct service methods)

```ts
// app/create_order/route.ts
import { createOpenReceive, OpenReceiveServiceError } from "@openreceive/node";

export const runtime = "nodejs";

const openreceiveReady = createOpenReceive({
  onPaid: async ({ orderId }) => {
    await markOrderPaidInYourApp(orderId);
  }
});

export async function POST(request: Request) {
  const openreceive = await openreceiveReady;

  try {
    const body = await request.json();
    const order = await createOrderFromCart(body.cart);
    const checkout = await openreceive.getOrCreateCheckout({
      orderId: order.uuid,
      usd: order.total_amount.value,
      memo: `Order ${order.number}`
    });
    return Response.json({ order, checkout }, { status: 201 });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      return Response.json(error.body, { status: error.status });
    }
    throw error;
  }
}
```

For App Router mounts of the shipped routes, use `openReceiveNextHandlers({ service, resolveOrder })`
under `app/openreceive/[...openreceive]/route.ts`.

## Controllers

You can also call OpenReceive from any controller that already owns checkout
access:

```ts
export async function createOrder(req, res, next) {
  try {
    const order = await createOrderFromCart(req.user, req.body.cart);
    const checkout = await openreceive.getOrCreateCheckout({
      orderId: order.uuid,
      usd: order.total_amount.value,
      memo: `Order ${order.number}`
    });
    res.status(201).json({ order, checkout });
  } catch (error) {
    next(error);
  }
}
```

## CORS And CSRF

Use your normal framework middleware:

```ts
app.use("/create_order", csrfProtection);
app.use("/order", csrfProtection);
app.use(["/create_order", "/order"], cors({
  origin: "https://shop.example",
  credentials: true
}));
```

Do not combine wildcard CORS with credentials. Same-origin mounts of `/openreceive` rely on
the httpOnly order-token cookie; keep CSRF protection on any cookie-authenticated POSTs your
app owns.

## Settlement

Frontend `onSettled` callbacks are display hints only. Fulfillment belongs in
the server-side settlement hook:

```ts
export const openreceive = await createOpenReceive({
  onPaid: async ({ orderId }) => {
    await markOrderPaidInYourApp(orderId);
  }
});
```

When an order is paid, fulfill against `order.paid_checkout`: it is the checkout
the customer actually paid.
