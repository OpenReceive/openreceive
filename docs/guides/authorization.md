# Authorization

OpenReceive mounts inside the app you already deploy. It does not define a
separate user-auth system. Your app supplies a merchant scope and the
authorization hooks for the routes it exposes.

## Merchant Scope

`merchantScope` is a function on `createOpenReceive()`:

```ts
import { createOpenReceive } from "@openreceive/node";

export const openreceive = await createOpenReceive({
  nwc: process.env.OPENRECEIVE_NWC!,
  merchantScope: (req) => req.user?.tenantId ?? "default",
  authorize: {
    request: (req) => Boolean(req.user),
    invoice: (req, invoice) => ownsInvoice(req, invoice),
    scheduler: (req) => isInternalScheduler(req)
  },
  cronSecret: process.env.OPENRECEIVE_CRON_SECRET
});
```

Use one stable scope per tenant, store, checkout surface, or app section that
must not share idempotency keys. The idempotency scope is:

```text
merchant_scope + operation + idempotency_key
```

The default is `() => "default"`. Keep the scope stable for all requests that
should replay the same invoice.

## Authorization Hooks

`createOpenReceive()` accepts one public authorization object:

```ts
authorize: {
  request: (req) => Boolean(req.user),
  invoice: (req, invoice) => ownsInvoice(req, invoice),
  scheduler: (req) => isInternalScheduler(req)
}
```

`authorize.request` gates invoice creation. Use it for signed-in users, guest
checkout tokens, cart sessions, or whatever already authorizes checkout in
your app.

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
  merchantScope: (req) => req.user?.tenantId ?? "default",
  authorize: {
    request: (req) => Boolean(req.user),
    invoice: (req, invoice) => ownsInvoice(req, invoice),
    scheduler: (req) => isInternalScheduler(req)
  },
  cronSecret: process.env.OPENRECEIVE_CRON_SECRET,
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

In a production build you must also set
`OPENRECEIVE_ALLOW_UNAUTHENTICATED_DEMO=true`; this double opt-in exists so you
cannot ship unauthenticated checkout by accident.

Production apps should provide authorization, CSRF protection for cookie POSTs,
and scheduler authorization when they expose the poll route.
