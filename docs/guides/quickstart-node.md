# Node Framework Quickstart

OpenReceive runs inside your app. Your server creates invoices with a
server-only receive NWC, your browser receives display-safe invoice data, and
backend lookup decides when payment settled.

The `@openreceive/*` packages are private until publishing is explicitly
approved. To run the reference path today, clone this repository and use the
demos:

```sh
npm install
npm run demo node
```

The install command below is the integration shape for a normal app once the
packages are published.

## Install

```sh
npm install @openreceive/node @openreceive/browser @openreceive/react express pg
```

Set the wallet secret only in your server environment:

```sh
OPENRECEIVE_NWC=nostr+walletconnect://...
OPENRECEIVE_STORE=local-sqlite
OPENRECEIVE_NAMESPACE=default
```

`OPENRECEIVE_STORE=local-sqlite` creates
`./.openreceive/<namespace>.sqlite3`. Use Postgres for multi-instance
production.

OpenReceive owns a package-owned Postgres or SQLite invoice store. Your app
keeps orders, carts, users, and fulfillment state in its own tables.

Scaffold and check the server config:

```sh
npx openreceive init
npx openreceive doctor
```

`init` writes `.env.openreceive.example` with the expected variable names.
`doctor` verifies storage, wallet preflight, and poll-route protection.

## Server

Create `server/openreceive.ts`:

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
  onPaid: async ({ invoice, metadata }) => {
    await markOrderPaid({
      orderId: metadata.order_id,
      invoiceId: invoice.invoice_id,
      paymentHash: invoice.payment_hash
    });
  }
});
```

`merchantScope` namespaces idempotency and invoice lookup inside one
OpenReceive store. Use one stable scope per tenant, store, or checkout surface.
The default is `() => "default"`.

`onPaid` runs after backend-verified settlement and is delivered at least once.
Make it idempotent by `payment_hash`, invoice id, or your own order id.

Create `server/index.ts`:

```ts
import express from "express";
import { openreceive } from "./openreceive";

const app = express();
app.use(express.json());

openreceive.mountExpress(app);

app.listen(3000);
```

This serves `/openreceive/v1/*`.

For local demos only, use the explicit unauthenticated escape hatch:

```ts
export const openreceive = await createOpenReceive({
  nwc: process.env.OPENRECEIVE_NWC!,
  unsafeAllowUnauthenticatedDemoMode: true
});
```

Do not use demo mode for production. In a production build you must also set
`OPENRECEIVE_ALLOW_UNAUTHENTICATED_DEMO=true`; this double opt-in exists so
you cannot ship unauthenticated checkout by accident.

## Client

Create an invoice with a stable order, cart, or payment-attempt id:

```tsx
import { createInvoice } from "@openreceive/browser";
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

const invoice = await createInvoice({
  idempotencyKey: orderId,
  fiat: { currency: "USD", value: "10.00" },
  metadata: { order_id: orderId }
});

<Checkout invoice={invoice} onPaid={() => showThankYou()} />;
```

The React `onPaid` callback is a UI hint only. Fulfillment belongs in the
server `onPaid` hook above.

## Other Frameworks

Every framework uses the same `createOpenReceive()` object.

Express:

Use `openreceive.mountExpress(app)` from the server step above.

Next.js App Router:

```ts
// app/openreceive/v1/[...openreceive]/route.ts
import { openreceive } from "@/server/openreceive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = (request: Request) => openreceive.handleFetch(request);

export const GET = handle;
export const POST = handle;
```

Any framework whose route receives a Web `Request` and returns a `Response` can
call `openreceive.handleFetch(request)` directly.

Raw Node or Fastify:

```ts
await openreceive.handleNode(req, res);
```

This writes the OpenReceive response to the Node response object.

## Production Add-Ons

Advanced production apps usually add:

- `authorize.invoice` for read, lookup, and refresh ownership checks.
- `authorize.scheduler` or `OPENRECEIVE_CRON_SECRET` for
  `POST /openreceive/v1/poll`.
- `csrf` for cookie-authenticated POST routes.
- `cors` when checkout runs on a different trusted origin.

## Doctor And Recovery

Run doctor during setup and deploy checks:

```sh
npx openreceive doctor
```

OpenReceive runs inside your normal web process:

```text
web process        mounts /openreceive/v1
browser checkout   polls /openreceive/v1/invoices/lookup
optional scheduler runs openreceive poll --once
```

Notifications are passive hints. Backend `lookup_invoice` is the settlement
authority. If you want extra recovery beyond route-triggered lookup, schedule:

```sh
npx openreceive poll --once
```

## Local Demos

```sh
npm run demo node
npm run demo nextjs
```
