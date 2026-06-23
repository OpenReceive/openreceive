# Node Framework Quickstart

OpenReceive runs inside your app. Your server creates invoices, your browser
shows display-safe checkout data, and backend lookup decides when the payment
settled. Browser code never receives `OPENRECEIVE_NWC`.

First get a receive-only NWC code:
https://openreceive.org/get_a_nwc_code_to_receive_payments

## Install

```sh
npm install @openreceive/node @openreceive/browser @openreceive/react express pg
```

Set the server-only wallet secret:

```sh
OPENRECEIVE_NWC=nostr+walletconnect://...
OPENRECEIVE_NAMESPACE=default
```

`OPENRECEIVE_STORE` defaults to `local-sqlite`, which creates
`./.openreceive/<namespace>.sqlite3`. Use Postgres for multi-instance
production:

```sh
OPENRECEIVE_STORE=postgres://user:pass@host:5432/appdb
```

OpenReceive owns a package-owned Postgres or SQLite invoice store. Your app
keeps orders, carts, users, and fulfillment state in its own tables.

## Doctor

Run doctor during setup and deploy checks:

```sh
npx openreceive doctor
```

Expected local output looks like:

```text
ok store local-sqlite namespace=default
ok store putIfAbsent/casMeta/listOpen round-trip
ok OPENRECEIVE_NWC configured (redacted)
ok config loaded
ok config store implements OpenReceive KV contract
ok NWC preflight completed (encryption=nip44_v2; methods=make_invoice,lookup_invoice)
```

Doctor checks that storage can create idempotent records, update coordination
metadata, and list open invoices. When a config file is present it also loads
your server config, verifies the store contract, runs NWC preflight, and warns
if the wallet advertises spend methods. OpenReceive still exposes only receive
checkout methods to your app.

## Server Setup

Create `server/openreceive.ts`:

```ts
import {
  createOpenReceive
} from "@openreceive/node";

export const openreceive = await createOpenReceive({
  merchantScope: (req) => `user:${req.user.id}`,
  authorize: {
    request: (req) => Boolean(req.user),
    invoice: (req, invoice) => ownsInvoice(req, invoice),
    scheduler: (req) => isInternalScheduler(req)
  },
  csrf: (req) => verifyCsrf(req),
  onPaymentSettled: async ({ invoice, metadata }) => {
    await markOrderPaid({
      invoiceId: invoice.invoice_id,
      orderId: metadata.order_id,
      paymentHash: invoice.payment_hash
    });
  }
});
```

`authorize.request` protects invoice creation. `authorize.invoice` protects
read, lookup, and refresh for an existing invoice. `authorize.scheduler`
protects optional recovery polling. If your framework already gates these
routes in controllers or middleware, call the same auth helpers here so
OpenReceive can still fail closed.

## Framework Routes

All framework routes mount the same API at `/openreceive/v1`.

Express:

```ts
import express from "express";
import {
  mountOpenReceiveExpress
} from "@openreceive/node";
import {
  openreceive
} from "./server/openreceive";

const app = express();
app.use(express.json());

mountOpenReceiveExpress(app, openreceive);

app.listen(3000);
```

Fetch-style frameworks such as Hono, SvelteKit, Remix, and Astro:

```ts
import {
  createOpenReceiveFetchHandler
} from "@openreceive/node";
import {
  openreceive
} from "./server/openreceive";

export const openreceiveRoute = createOpenReceiveFetchHandler(openreceive);
```

Hono:

```ts
app.all("/openreceive/v1/*", (c) => openreceiveRoute(c.req.raw));
```

SvelteKit:

```ts
export const GET = ({ request }) => openreceiveRoute(request);
export const POST = ({ request }) => openreceiveRoute(request);
```

Fastify:

```ts
import {
  createOpenReceiveNodeHandler
} from "@openreceive/node";
import {
  openreceive
} from "./server/openreceive";

const openreceiveNode = createOpenReceiveNodeHandler(openreceive);

fastify.all("/openreceive/v1/*", async (request, reply) => {
  reply.hijack();
  await openreceiveNode(request.raw, reply.raw);
});
```

Koa:

```ts
const openreceiveNode = createOpenReceiveNodeHandler(openreceive);

router.all("/openreceive/v1/(.*)", async (ctx) => {
  ctx.respond = false;
  await openreceiveNode(ctx.req, ctx.res);
});
```

Raw Node:

```ts
import {
  createServer
} from "node:http";
import {
  createOpenReceiveNodeHandler
} from "@openreceive/node";
import {
  openreceive
} from "./server/openreceive";

const openreceiveNode = createOpenReceiveNodeHandler(openreceive);

createServer((req, res) => {
  void openreceiveNode(req, res);
}).listen(3000);
```

NestJS on Express mounts the same Express helper on the underlying Express app.

## Next.js App Router

Install:

```sh
npm install @openreceive/node @openreceive/next @openreceive/react pg
```

Create `src/server/openreceive.ts`:

```ts
import {
  createOpenReceive
} from "@openreceive/node";

export const openreceive = await createOpenReceive({
  merchantScope: () => "app:default",
  authorize: {
    request: (req) => isAllowedToCreateInvoice(req),
    invoice: (req, invoice) => ownsInvoice(req, invoice),
    scheduler: (req) => isInternalScheduler(req)
  },
  csrf: (req) => verifyCsrf(req),
  onPaymentSettled: async ({ invoice, metadata }) => {
    await markOrderPaid({
      invoiceId: invoice.invoice_id,
      orderId: metadata.order_id
    });
  }
});
```

Create `src/app/openreceive/v1/[...openreceive]/route.ts`:

```ts
import {
  dispatchOpenReceiveNextRoute
} from "@openreceive/next";
import {
  openreceive
} from "@/server/openreceive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = {
  params: Promise<{
    openreceive?: string[];
  }>;
};

async function handle(request: Request, context: Context) {
  const params = await context.params;
  return dispatchOpenReceiveNextRoute({
    runtime: openreceive.runtime,
    request,
    path: params.openreceive ?? []
  });
}

export const GET = handle;
export const POST = handle;
```

## Browser Checkout

To get paid for something, create an invoice for that order or cart. The
idempotency key is the stable order, cart, or payment-attempt id that prevents
duplicate invoices if the customer double-clicks or retries.

```ts
import {
  createOpenReceiveInvoice
} from "@openreceive/browser";

const invoice = await createOpenReceiveInvoice({
  idempotencyKey: orderId,
  fiat: {
    currency: "USD",
    value: "10.00"
  },
  metadata: {
    order_id: orderId
  }
});
```

Then render checkout:

```tsx
import {
  OpenReceiveCheckout
} from "@openreceive/react";
import "@openreceive/react/styles.css";

export function Checkout({ invoice }) {
  return (
    <OpenReceiveCheckout
      {...invoice}
      lookupUrl="/openreceive/v1/invoices/lookup"
    />
  );
}
```

No-framework apps can use `@openreceive/elements` or lower-level browser
helpers.

## Recovery

Your web process is enough for normal checkout:

```text
web process        mounts /openreceive/v1
browser checkout   polls /openreceive/v1/invoices/lookup
optional scheduler runs openreceive poll --once
```

Do not deploy a wallet notification listener. Notifications are passive hints;
backend `lookup_invoice` is the settlement authority. If you want extra
recovery beyond route-triggered lookup, schedule:

```sh
npx openreceive poll --once
```

See [Background Process Deployment](17-background-workers.md) for Vercel,
Cloudflare, Netlify, Railway, Render, Heroku, Fly.io, ECS, systemd/VPS,
Coolify, Dokploy, and Kamal examples.

## Local Demo

```sh
npm run demo node
npm run demo nextjs
```
