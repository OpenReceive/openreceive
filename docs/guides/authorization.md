# App Route Protection

Use the routes, controllers, and middleware your app already uses for checkout.
OpenReceive supplies service methods you can call from those routes; it does
not define a public route layout for you.

## Express

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

Mount `checkoutRoutes` wherever your app already mounts checkout controllers.

## Next.js

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

Put route files under the checkout path your app already controls.

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

Do not combine wildcard CORS with credentials.

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
