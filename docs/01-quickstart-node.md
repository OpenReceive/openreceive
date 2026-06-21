# Node Framework Quickstart

OpenReceive runs inside your app. Pick the framework path you use, add the
server route, then render the display-safe checkout UI in the browser.

Supported Node paths today:

| App | Use |
| --- | --- |
| Express | `@openreceive/express` |
| Next.js App Router | `@openreceive/next` |
| Other Node frameworks | Use an Express-compatible mount or build a thin adapter around the route handlers. |

Live checkout always needs a server component. Browser code never receives
`OPENRECEIVE_NWC`.

## Common Setup

Set the wallet secret in your app's server environment:

```sh
OPENRECEIVE_NWC=nostr+walletconnect://...
```

Run the OpenReceive invoice migration in the same database your app already
uses:

```sh
npx openreceive migrate --postgres "$DATABASE_URL"
npx openreceive doctor --postgres "$DATABASE_URL"
```

If your app uses a different env name, pass that value instead. SQLite apps can
use `--sqlite ./storage/openreceive.sqlite3`.

MongoDB, MySQL, and arbitrary user-designed invoice tables are not supported
until OpenReceive ships a store, migration path, and conformance coverage for
them.

## Express

Install:

```sh
npm install @openreceive/node @openreceive/express @openreceive/browser express pg
```

Create `server/openreceive.ts`:

```ts
import pg from "pg";
import {
  createAlbyNwcReceiveClient,
  createOpenReceivePostgresInvoiceStoreFromPool
} from "@openreceive/node";

const nwc = process.env.OPENRECEIVE_NWC;
if (!nwc) throw new Error("Set OPENRECEIVE_NWC");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

export const openreceive = {
  client: createAlbyNwcReceiveClient({
    connectionString: nwc
  }),
  store: createOpenReceivePostgresInvoiceStoreFromPool({
    pool
  }),
  merchantScope: (req) => `user:${req.user.id}`,
  auth: {
    create: (req) => Boolean(req.user),
    read: (req, invoice) => ownsInvoice(req, invoice),
    lookup: (req, invoice) => ownsInvoice(req, invoice),
    events: (req, invoice) => ownsInvoice(req, invoice)
  },
  csrf: {
    verify: (req) => verifyCsrf(req)
  },
  settlementAction: async ({ invoice, metadata }) => {
    await markOrderPaid({
      invoiceId: invoice.invoice_id,
      orderId: metadata.order_id
    });
  }
};
```

Mount it in your Express server:

```ts
import express from "express";
import { mountOpenReceiveExpressRoutes } from "@openreceive/express";
import { openreceive } from "./server/openreceive";

const app = express();
app.use(express.json());

mountOpenReceiveExpressRoutes(app, openreceive);

app.listen(3000);
```

That adds the OpenReceive API at `/openreceive/v1`.

## Next.js App Router

Install:

```sh
npm install @openreceive/node @openreceive/next @openreceive/react pg
```

Create `src/server/openreceive.ts`:

```ts
import pg from "pg";
import {
  createAlbyNwcReceiveClient,
  createOpenReceivePostgresInvoiceStoreFromPool
} from "@openreceive/node";
import {
  createOpenReceiveNextRuntime,
  dispatchOpenReceiveNextNoWalletRoute,
  dispatchOpenReceiveNextRoute
} from "@openreceive/next";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

let runtime;

function getRuntime() {
  if (runtime) return runtime;

  const nwc = process.env.OPENRECEIVE_NWC;
  if (!nwc) return undefined;

  runtime = createOpenReceiveNextRuntime({
    client: createAlbyNwcReceiveClient({
      connectionString: nwc
    }),
    store: createOpenReceivePostgresInvoiceStoreFromPool({
      pool
    }),
    merchantScope: () => "merchant:default",
    auth: {
      create: (req) => isAllowedToCreateInvoice(req),
      read: (req, invoice) => ownsInvoice(req, invoice),
      lookup: (req, invoice) => ownsInvoice(req, invoice),
      events: (req, invoice) => ownsInvoice(req, invoice)
    },
    csrf: {
      verify: (req) => verifyCsrf(req)
    },
    settlementAction: async ({ invoice, metadata }) => {
      await markOrderPaid({
        invoiceId: invoice.invoice_id,
        orderId: metadata.order_id
      });
    }
  });

  return runtime;
}

export function openReceiveRoute(request: Request, path: readonly string[]) {
  const openreceive = getRuntime();
  if (openreceive === undefined) {
    return dispatchOpenReceiveNextNoWalletRoute({ request, path });
  }

  return dispatchOpenReceiveNextRoute({
    runtime: openreceive,
    request,
    path
  });
}
```

Create one catch-all route at
`src/app/openreceive/v1/[...openreceive]/route.ts`:

```ts
import { openReceiveRoute } from "@/server/openreceive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = {
  params: Promise<{
    openreceive?: string[];
  }>;
};

async function handle(request: Request, context: Context) {
  const params = await context.params;
  return openReceiveRoute(request, params.openreceive ?? []);
}

export const GET = handle;
export const POST = handle;
```

That adds the same `/openreceive/v1` API through Next route handlers.

## Browser Checkout

Your UI creates an invoice by posting to the server route:

```ts
const response = await fetch("/openreceive/v1/invoices", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": orderId
  },
  body: JSON.stringify({
    fiat: {
      currency: "USD",
      value: "10.00"
    },
    metadata: {
      order_id: orderId
    }
  })
});

const invoice = await response.json();
```

React apps can render the checkout with `@openreceive/react`:

```tsx
import { OpenReceiveCheckout } from "@openreceive/react";
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

No-framework apps can use `@openreceive/elements` or the lower-level
`@openreceive/browser` helpers.

## Workers

Run polling as a separate backend process so open invoices recover after
restart:

```sh
npx openreceive poll --config ./openreceive.config.mjs
```

If your wallet supports `payment_received` notifications, also run:

```sh
npx openreceive listen --config ./openreceive.config.mjs
```

The config module should export the same server-only `openreceive` object used
by your framework route. The poll process remains the settlement authority even
when notifications are enabled.

## Other Node Frameworks

First-class v0.1 adapters are Express and Next.js App Router. For NestJS on the
Express platform, mount the Express adapter. For Fastify, Koa, Hono, Remix,
SvelteKit, Astro, or custom servers, keep the same boundaries:

- mount the OpenReceive HTTP routes under `/openreceive/v1`
- keep `OPENRECEIVE_NWC` server-only
- use the package-owned Postgres or SQLite invoice store
- protect create/read/lookup/events with your app's auth and CSRF rules
- run the poll worker outside the request process

If the framework can host Express middleware, use `mountOpenReceiveExpressRoutes`.
Otherwise, build a small adapter around `createOpenReceiveExpressHandlers()` and
the HTTP contract in [API Reference](api-reference.md).

## Local Demo

To see a working Express + React app:

```sh
npm run demo node
```

To see a working Next.js App Router app:

```sh
npm run demo nextjs
```
