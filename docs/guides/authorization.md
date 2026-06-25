# App Route Protection

Use the routes, controllers, and middleware your app already uses for checkout.
OpenReceive supplies service methods you can call from those routes.

## Express

```ts
import express from "express";
import {
  OpenReceiveServiceError,
  createOpenReceive
} from "@openreceive/node";

const checkoutRoutes = express.Router();
checkoutRoutes.use(express.json());

const openreceive = await createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderUuid);
  },
});

checkoutRoutes.post("/create_order", async (req, res, next) => {
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
    if (error instanceof OpenReceiveServiceError) {
      res.status(error.status).json(error.body);
      return;
    }
    next(error);
  }
});

checkoutRoutes.post("/order_status", async (req, res, next) => {
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
    return Response.json({ order, invoice }, {
      status: 201
    });
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

You can also call OpenReceive from a controller that already owns checkout
access:

```ts
export async function createOrder(req, res, next) {
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
    next(error);
  }
}
```

Use this shape inside controller actions your app already protects.

## CORS And CSRF

Use your normal framework middleware:

```ts
app.use("/create_order", csrfProtection);
app.use("/order_status", csrfProtection);
app.use(["/create_order", "/order_status"], cors({
  origin: "https://shop.example",
  credentials: true
}));
```

Do not combine wildcard CORS with credentials.

## Settlement

Frontend `onPaid` callbacks are display hints only. Fulfillment belongs in
server-side `onPaid`:

```ts
export const openreceive = await createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderUuid);
  }
});
```

`orderUuid` is guaranteed to be the unique app order key for this checkout, so
use it for idempotent fulfillment. Invoice details are available only if your
app wants extra audit or correlation data.
