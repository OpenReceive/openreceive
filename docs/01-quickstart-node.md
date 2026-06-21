# Node Framework Quickstart

OpenReceive runs inside your app. Pick the framework path you use, add the
server route, then render the display-safe checkout UI in the browser.

Supported Node paths today:

| App | Use |
| --- | --- |
| Express | `mountOpenReceiveExpressRoutes()` from `@openreceive/express` |
| Next.js App Router | one catch-all route with `@openreceive/next` |
| Hono, SvelteKit, Remix, Astro, Fetch-style servers | `createOpenReceiveFetchHandler()` from `@openreceive/express` |
| Fastify, Koa, raw Node HTTP | `createOpenReceiveNodeHandler()` from `@openreceive/express` |
| NestJS on Express | mount the Express adapter on the underlying Express app |

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
  createOpenReceivePostgresInvoiceStoreFromPool,
  formatOpenReceiveMissingNwcMessage
} from "@openreceive/node";

const nwc = process.env.OPENRECEIVE_NWC;
if (!nwc) {
  const message = formatOpenReceiveMissingNwcMessage();
  console.error(message);
  throw new Error(message);
}

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

## Fetch And Raw Node Frameworks

Use this path for Hono, SvelteKit, Remix, Astro, Fastify, Koa, and any Node
framework that hands route handlers a standard Fetch `Request` or raw Node
request/response pair.

Install:

```sh
npm install @openreceive/node @openreceive/express @openreceive/browser pg
```

Create `server/openreceive.ts`:

```ts
import pg from "pg";
import {
  createOpenReceiveFetchHandler,
  createOpenReceiveFetchRuntime,
  createOpenReceiveNodeHandler
} from "@openreceive/express";
import {
  createAlbyNwcReceiveClient,
  createOpenReceivePostgresInvoiceStoreFromPool,
  formatOpenReceiveMissingNwcMessage
} from "@openreceive/node";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

let runtime;

function getRuntime() {
  if (runtime) return runtime;

  const nwc = process.env.OPENRECEIVE_NWC;
  if (!nwc) {
    const message = formatOpenReceiveMissingNwcMessage();
    console.error(message);
    throw new Error(message);
  }

  runtime = createOpenReceiveFetchRuntime({
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

export const openreceive = createOpenReceiveFetchHandler({
  runtime: getRuntime
});

export const openreceiveNode = createOpenReceiveNodeHandler({
  runtime: getRuntime
});
```

Hono:

```ts
import { Hono } from "hono";
import { openreceive } from "./server/openreceive";

const app = new Hono();

app.all("/openreceive/v1/*", (c) => openreceive(c.req.raw));
```

SvelteKit:

```ts
// src/routes/openreceive/v1/[...openreceive]/+server.ts
import { openreceive } from "$lib/server/openreceive";

export const GET = ({ request }) => openreceive(request);
export const POST = ({ request }) => openreceive(request);
```

Remix, Astro, and other Fetch-style Node routes use the same `openreceive`
handler from their catch-all route file.

Fastify:

```ts
import { openreceiveNode } from "./server/openreceive";

fastify.all("/openreceive/v1/*", async (request, reply) => {
  reply.hijack();
  await openreceiveNode(request.raw, reply.raw);
});
```

Koa:

```ts
import Router from "@koa/router";
import { openreceiveNode } from "./server/openreceive";

const router = new Router();

router.all("/openreceive/v1/(.*)", async (ctx) => {
  ctx.respond = false;
  await openreceiveNode(ctx.req, ctx.res);
});
```

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
  createOpenReceivePostgresInvoiceStoreFromPool,
  formatOpenReceiveMissingNwcMessage
} from "@openreceive/node";
import {
  createOpenReceiveNextRuntime,
  dispatchOpenReceiveNextRoute
} from "@openreceive/next";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

let runtime;

function getRuntime() {
  if (runtime) return runtime;

  const nwc = process.env.OPENRECEIVE_NWC;
  if (!nwc) {
    const message = formatOpenReceiveMissingNwcMessage();
    console.error(message);
    throw new Error(message);
  }

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

## Background Processes

In production, run your web server plus one OpenReceive backend worker:

```text
web                 npm start
openreceive-worker  npx openreceive worker
```

The config module should export the same server-only `openreceive` object used
by your framework route. You do not need to decide whether your wallet supports
notifications. The worker starts both polling and listening; if no notifications
arrive, polling still recovers and settles invoices.

On serverless-only hosts, use a scheduled route or cron job to run one polling
pass:

```sh
npx openreceive poll --once
```

See [Background Process Deployment](17-background-workers.md) for Vercel,
Netlify, Cloudflare, Railway, Render, Heroku, Fly.io, DigitalOcean, Google
Cloud Run, Coolify, Dokploy, Kamal, and VPS examples.

## Other Node Frameworks

First-class v0.1 server bridges are Express, Next.js App Router, generic Fetch
`Request`/`Response`, and raw Node request/response. For NestJS on the Express
platform, mount the Express adapter. Keep the same boundaries:

- mount the OpenReceive HTTP routes under `/openreceive/v1`
- keep `OPENRECEIVE_NWC` server-only
- use the package-owned Postgres or SQLite invoice store
- protect create/read/lookup/events with your app's auth and CSRF rules
- run `openreceive worker` outside the request process

If the framework can host Express middleware, use `mountOpenReceiveExpressRoutes`.
If it exposes Fetch `Request` objects, use `createOpenReceiveFetchHandler()`.
If it exposes raw Node request/response objects, use
`createOpenReceiveNodeHandler()`.
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
