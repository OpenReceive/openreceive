# Node Framework Quickstart

OpenReceive runs inside your app. Your server creates invoices with a
server-only receive NWC, your browser receives display-safe invoice data, and
backend lookup decides when payment settled.

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

## Server

Create `server/openreceive.ts`:

```ts
import { createOpenReceive } from "@openreceive/node";

export const openreceive = await createOpenReceive({
  nwc: process.env.OPENRECEIVE_NWC!,
  authorize: {
    request: (req) => Boolean(req.user)
  },
  onPaid: async ({ invoice, metadata }) => {
    await markOrderPaid({
      orderId: metadata.order_id,
      invoiceId: invoice.invoice_id,
      paymentHash: invoice.payment_hash
    });
  }
});
```

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

Do not use demo mode for production.

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

Fetch-style handlers:

```ts
export const GET = ({ request }) => openreceive.handleFetch(request);
export const POST = ({ request }) => openreceive.handleFetch(request);
```

Next.js App Router catch-all:

```ts
import { openreceive } from "@/server/openreceive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = (request: Request) => openreceive.handleFetch(request);

export const GET = handle;
export const POST = handle;
```

Raw Node or Fastify:

```ts
await openreceive.handleNode(req, res);
```

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

Normal checkout does not require a worker:

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
