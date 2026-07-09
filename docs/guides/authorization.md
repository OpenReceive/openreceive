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
      amount: { currency: "USD", value: order.total_amount.value },
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
    // check) before calling the service. order_id is an identifier, not a capability.
    const orderId = req.body.order_id;
    const action = req.body.action ?? "status";
    if (action === "status") {
      const order = await openreceive.getOrder({ orderId });
      const swap = await openreceive.swapOptions({ orderId });
      res.json({
        ...order,
        swapsEnabled: swap.enabled,
        swapPayOptions: swap.enabled ? swap.options : [],
      });
      return;
    }
    if (action === "swap_quote") {
      res.json({
        quote: await openreceive.swapQuote({
          orderId,
          payInAsset: req.body.pay_in_asset,
        }),
      });
      return;
    }
    if (action === "start_swap") {
      res.json({
        attempt: await openreceive.startSwap({
          orderId,
          payInAsset: req.body.pay_in_asset,
        }),
      });
      return;
    }
    if (action === "refund_swap") {
      res.json({
        attempt: await openreceive.refundSwap({
          attemptId: req.body.attempt_id,
          refundAddress: req.body.refund_address,
          refundNonce: req.body.refund_nonce,
          confirm: req.body.confirm === true,
        }),
      });
      return;
    }
    res.status(400).json({
      code: "INVALID_REQUEST",
      message: 'Unknown order action. Expected "status", "swap_quote", "start_swap", or "refund_swap".',
    });
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
      amount: { currency: "USD", value: order.total_amount.value },
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
      amount: { currency: "USD", value: order.total_amount.value },
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
