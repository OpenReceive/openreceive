# App Route Protection

Use the routes, controllers, and middleware your app already uses for checkout.
OpenReceive supplies service methods you can call from those routes.

## Express

```ts
import express from "express";
import { createOpenReceive } from "@openreceive/node";

const checkoutRoutes = express.Router();
checkoutRoutes.use(express.json());

const openreceive = await createOpenReceive({
  onPaid: async ({ orderId }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderId);
  },
});

checkoutRoutes.post("/create_order", async (req, res, next) => {
  try {
    // Your app function. Create and validate the order before calling OpenReceive.
    const order = await createOrderFromCart(req.user, req.body.cart);
    const invoice = await openreceive.createInvoice({
      orderId: order.uuid,
      amount: {
        fiat: {
          currency: order.totalAmount.currency,
          value: order.totalAmount.value
        }
      },
      memo: `Order ${order.number}`,
      expiresInSeconds: 600
    });
    res.status(201).json({ order, invoice });
  } catch (error) {
    sendCheckoutError(res, next, error);
  }
});

checkoutRoutes.post("/order_status", async (req, res, next) => {
  try {
    const invoice = await openreceive.refreshInvoiceStatus({
      invoiceId: req.body.invoice_id
    });
    res.status(200).json({
      ...invoice,
      order_status: invoice.settledAt || invoice.transactionState === "settled"
        ? "settled"
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
```

Mount `checkoutRoutes` wherever your app already mounts checkout controllers.

## Next.js

```ts
// app/create_order/route.ts
import { createOpenReceive } from "@openreceive/node";

export const runtime = "nodejs";

const openreceiveReady = createOpenReceive({
  onPaid: async ({ orderId }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderId);
  },
});

export async function POST(request: Request) {
  const openreceive = await openreceiveReady;
  try {
    const body = await request.json();
    // Your app function. Create and validate the order before calling OpenReceive.
    const order = await createOrderFromCart(body.cart);
    const invoice = await openreceive.createInvoice({
      orderId: order.uuid,
      amount: {
        fiat: {
          currency: order.totalAmount.currency,
          value: order.totalAmount.value
        }
      },
      memo: `Order ${order.number}`,
      expiresInSeconds: 600
    });
    return Response.json({ order, invoice }, {
      status: 201
    });
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

Put route files under the checkout path your app already controls.

## Controllers

You can also call OpenReceive from a controller that already owns checkout
access:

```ts
export async function createOrder(req, res, next) {
  try {
    // Your app function. Create and validate the order before calling OpenReceive.
    const order = await createOrderFromCart(req.user, req.body.cart);
    const invoice = await openreceive.createInvoice({
      orderId: order.uuid,
      amount: {
        fiat: {
          currency: order.totalAmount.currency,
          value: order.totalAmount.value
        }
      },
      memo: `Order ${order.number}`,
      expiresInSeconds: 600
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

Frontend `onSettled` callbacks are display hints only. Fulfillment belongs in
server-side settlement hook:

```ts
export const openreceive = await createOpenReceive({
  onPaid: async ({ orderId }) => {
    // Your app function, not OpenReceive.
    await markOrderPaidInYourApp(orderId);
  }
});
```

`orderId` is guaranteed to be the unique app order key for this checkout, so
use it for idempotent fulfillment. Invoice details are available only if your
app wants extra audit or correlation data.
