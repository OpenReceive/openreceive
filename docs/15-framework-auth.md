# Framework Auth And Browser Security

OpenReceive mounts inside the app you already deploy. It does not define a
separate user-auth system; your app supplies the authorization hooks.

## The Three Hooks

`createOpenReceive()` accepts one public authorization object:

```ts
authorize: {
  request: (req) => Boolean(req.user),
  invoice: (req, invoice) => ownsInvoice(req, invoice),
  scheduler: (req) => isInternalScheduler(req)
}
```

`authorize.request` gates invoice creation.

`authorize.invoice` gates read, lookup, and refresh for an existing invoice.
Use the same ownership rule you use for the order, cart, checkout session, or
user that owns the invoice.

`authorize.scheduler` gates the optional recovery poll route. You can also use
`OPENRECEIVE_CRON_SECRET` / `cronSecret` for platform schedulers.

## Production Config

```ts
import { createOpenReceive } from "@openreceive/node";

export const openreceive = await createOpenReceive({
  nwc: process.env.OPENRECEIVE_NWC!,
  authorize: {
    request: (req) => Boolean(req.user),
    invoice: (req, invoice) => ownsInvoice(req, invoice),
    scheduler: (req) => isInternalScheduler(req)
  },
  csrf: (req) => verifyCsrf(req),
  cors: {
    allowed_origins: ["https://shop.example"],
    credentials: true
  },
  onPaid: async ({ invoice, metadata }) => {
    await markOrderPaid({
      orderId: metadata.order_id,
      paymentHash: invoice.payment_hash
    });
  }
});
```

Write `onPaid` as an idempotent backend action. It runs only after backend
wallet lookup proves settlement, and it may be delivered again after a crash.

## CSRF

Cookie-authenticated POST routes need CSRF protection. Pass the same CSRF
verification your app already uses through `csrf`.

## CORS

Credentialed cross-origin access is disabled by default. Add explicit origins
only for trusted checkout domains, and never combine wildcard CORS with
credentials.

## Demo Mode

`unsafeAllowUnauthenticatedDemoMode` is only for local or deliberately public
low-value demos:

```ts
await createOpenReceive({
  nwc: process.env.OPENRECEIVE_NWC!,
  unsafeAllowUnauthenticatedDemoMode: true
});
```

Production apps should provide authorization, CSRF protection for cookie POSTs,
and scheduler authorization when they expose the poll route.
