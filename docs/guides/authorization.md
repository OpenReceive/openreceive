# App Route Protection

Use the routes, controllers, and middleware your app already uses for checkout.
OpenReceive supplies handlers you can call from those routes.

## Express

```ts
import express from "express";
import { createOpenReceive } from "@openreceive/node";

const checkoutRoutes = express.Router();
checkoutRoutes.use(express.json());

const openreceive = await createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    await markOrderPaid(orderUuid);
  },
});
const or = openreceive.handlers;

checkoutRoutes.post("/openreceive/v1/invoices", or.createInvoice);
checkoutRoutes.get("/openreceive/v1/invoices/:invoice_id", or.getInvoice);
checkoutRoutes.post("/openreceive/v1/invoices/lookup", or.lookupInvoice);
```

Mount `checkoutRoutes` wherever your app already mounts checkout controllers.

## Next.js

```ts
// app/openreceive/v1/[...openreceive]/route.ts
import { createOpenReceive } from "@openreceive/node";

export const runtime = "nodejs";

const openreceiveReady = createOpenReceive({
  onPaid: async ({ orderUuid }) => {
    await markOrderPaid(orderUuid);
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

Put this route file under the checkout path your app already controls.

## Controllers

You can also call OpenReceive from a controller that already owns checkout
access:

```ts
export async function createCheckoutInvoice(req, res, next) {
  return openreceive.handlers.createInvoice(req, res, next);
}
```

Use this shape inside controller actions your app already protects.

## CORS And CSRF

Use your normal framework middleware:

```ts
app.use("/openreceive/v1", csrfProtection);
app.use("/openreceive/v1", cors({
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
    await markOrderPaid(orderUuid);
  }
});
```

`markOrderPaid` is your app code. `orderUuid` is guaranteed to be the unique app
order key for this checkout, so use it for idempotent fulfillment. Invoice
details are available only if your app wants extra audit or correlation data.
