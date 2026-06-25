# App Route Protection

OpenReceive does not implement authentication, sessions, CSRF, or CORS. Mount
its handlers inside the routes/controllers your app already protects.

## Express

```ts
import express from "express";
import { openreceive } from "./openreceive";

const app = express();
app.use(express.json());

app.use("/openreceive/v1", requireCheckoutAccess);
openreceive.mountExpress(app);
```

`requireCheckoutAccess` can check a signed-in user, a guest checkout token, a
cart session, or whatever your app already trusts for checkout.

## Next.js

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

## Controllers

You can also call OpenReceive from a controller that already owns checkout
access:

```ts
export async function createCheckoutInvoice(req, res, next) {
  await requireCheckoutAccess(req);
  return openreceive.handlers.createInvoice(req, res, next);
}
```

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
  onPaid: async ({ orderUuid, invoice }) => {
    await markOrderPaid({
      orderUuid,
      paymentHash: invoice.payment_hash
    });
  }
});
```

Make the hook idempotent by `orderUuid`, `payment_hash`, or invoice id.
