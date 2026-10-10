# TanStack Start recipe

OpenReceive ships no TanStack Start package. A TanStack Start server route
takes a Web-standard `Request` and returns a `Response`, and so does
`@openreceive/http`, so the integration is the route below. Your server code
creates each Lightning invoice, the payment goes straight to your wallet, and
payment attempts are stored in your app's Postgres database. There is no
OpenReceive account and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

This recipe was checked with `@tanstack/react-start` 1.168 and
`@openreceive/*` 0.4.19. The app was built with Lovable's Vite config for
Cloudflare Workers and run under workerd: a buyer's checkout showed a real
Lightning invoice, and a stranger was refused. The Supabase route below runs
in OpenReceive's CI as a Worker, against Supabase's own Postgres image and
API server: a buyer's invoice, a stranger refused, one live attempt under
concurrent requests, and a payment that `openreceive_on_paid` fulfills once.

```sh
npm install @openreceive/http @openreceive/react pg
```

## Where it runs

- **Node** (the `node-server` preset, or any Node host): any Postgres.
- **Cloudflare Workers** (the `cloudflare-module` preset, Lovable's default):
  with Node compatibility, and a Postgres whose certificate a public
  authority signed, such as Neon.
- **Cloudflare Workers with Supabase**, which is every Lovable app: a Worker
  cannot open a Postgres connection to Supabase, whose certificate comes from
  a private authority. Use [On Supabase](#on-supabase-lovable) below, which
  stores payments through Supabase's HTTPS API instead.

Workers ties every socket to the request that opened it, and forbids network
calls at import. So the route builds its database pool and its OpenReceive
stack inside each request, and closes both before it responds. Each request
then opens its own wallet connection; in our test a checkout request took one
to four seconds. The same code works on Node.

## The payment route

Keep the handler in a `.server.ts` module. Route files are also bundled for
the browser, so the route loads the module only when a request arrives:

```ts
// src/routes/openreceive.$.ts — every route under /openreceive/
import { createFileRoute } from "@tanstack/react-router";

async function openReceive({ request }: { request: Request }): Promise<Response> {
  const { handleOpenReceive } = await import("@/lib/openreceive.server");
  return handleOpenReceive(request);
}

export const Route = createFileRoute("/openreceive/$")({
  server: { handlers: { GET: openReceive, POST: openReceive } },
});
```

```ts
// src/lib/openreceive.server.ts
import { createStack } from "@openreceive/http";
import pg from "pg";
import { findOrder, currentVisitor } from "./orders.server"; // your own orders

export async function handleOpenReceive(request: Request): Promise<Response> {
  // Read process.env inside the handler: on Workers it is empty at import.
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const stack = createStack({
    wallet: { nwc: process.env.NWC_URI ?? "" },
    storage: {
      db: pool,
      // Runs once, inside the transaction that records the payment.
      onPaid: async ({ reference, paidAt, query }) => {
        await query(
          "UPDATE orders SET state = 'paid', paid_at = $1 WHERE id = $2 AND state = 'awaiting_payment'",
          [paidAt, reference],
        );
      },
    },
    // The price comes from the order row, never from the request.
    amountFor: async (reference) => {
      const order = await findOrder(pool, reference);
      return order?.state === "awaiting_payment"
        ? { currency: order.currency, value: order.amount, description: order.title }
        : null;
    },
    // Only the buyer may pay for their order.
    authorize: async ({ request: incoming, resource }) => {
      const order = resource.reference ? await findOrder(pool, resource.reference) : undefined;
      const visitor = currentVisitor(incoming);
      return Boolean(order && visitor && order.visitor === visitor);
    },
    // Cloudflare sets cf-connecting-ip on every request, and a client cannot.
    // On Node behind your own proxy, read the header that proxy sets.
    rateLimiting: {
      ip: ({ request: incoming }) => incoming.headers.get("cf-connecting-ip") ?? undefined,
    },
  });
  try {
    return await stack.handler(request, { native: request });
  } finally {
    await stack.close();
    await pool.end();
  }
}
```

`authorize` sees the incoming request with its cookies, so check it with
the session your app already has. The [Next.js quickstart](../guides/quickstart-next.md)
explains each hook. They are the same here.

Create OpenReceive's two tables with your migrations, or run
`paymentsSchemaSql("postgres")` from `@openreceive/http` once. It is
idempotent. See [Payment storage](../guides/storage.md).

## On Supabase (Lovable)

On Supabase the route keeps payments in your Supabase database through its
HTTPS API, with the project's secret key. There is no `pg` pool. Use
`@openreceive/*` 0.4.23 or newer:

```sh
npm install @openreceive/http @openreceive/react
```

1. Apply the migration from `npx openreceive scaffold payments --supabase`.
   It creates OpenReceive's tables, locked away from the browser's Supabase
   key, and the functions that write them.
2. Replace its placeholder `openreceive_on_paid` with the SQL that marks your
   order paid. It runs inside the transaction that records the payment, for
   the order's first payment only, so a failure there records nothing:

   ```sql
   create or replace function public.openreceive_on_paid(
     p_reference text, p_payment_hash text, p_paid_at bigint
   ) returns void language plpgsql as $$
   begin
     update public.orders set status = 'paid'
      where id = p_reference::uuid and status = 'pending';
   end
   $$;
   ```

3. Write the route's server module:

```ts
// src/lib/openreceive.server.ts
import { createStack } from "@openreceive/http";
import { findOrder, currentBuyer } from "./orders.server"; // your own orders

export async function handleOpenReceive(request: Request): Promise<Response> {
  // Read process.env inside the handler: on Workers it is empty at import.
  // Lovable sets SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for server code.
  const stack = createStack({
    wallet: { nwc: process.env.NWC_URI ?? "" },
    storage: {
      supabase: {
        url: process.env.SUPABASE_URL ?? "",
        key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      },
    },
    // The price comes from the order row, never from the request.
    amountFor: async (reference) => {
      const order = await findOrder(reference);
      return order?.status === "pending"
        ? { currency: order.currency, value: order.total, description: order.title }
        : null;
    },
    // Only the buyer may pay for their order.
    authorize: async ({ request: incoming, resource }) => {
      const order = resource.reference ? await findOrder(resource.reference) : null;
      const buyer = currentBuyer(incoming);
      return Boolean(order && buyer && order.buyer_token === buyer);
    },
    rateLimiting: {
      ip: ({ request: incoming }) => incoming.headers.get("cf-connecting-ip") ?? undefined,
    },
  });
  try {
    return await stack.handler(request, { native: request });
  } finally {
    await stack.close();
  }
}
```

There is no `onPaid`: `openreceive_on_paid` is the fulfillment. `findOrder`
reads the order with your server-side Supabase client; in a Lovable app that
is `supabaseAdmin` from `@/integrations/supabase/client.server`.

The checkout calls the payment routes from the browser with the page's
cookies, and nothing else. A Lovable app keeps its Supabase sign-in in the
browser, not in a cookie, so `authorize` cannot see who is signed in. Give
the buyer a cookie of their own instead: create orders in a server function
that sets an HttpOnly `buyer` cookie (a random value, kept across orders) and
stores the same value on the order as `buyer_token`. `currentBuyer` reads it
back from the request's `cookie` header.

Before it serves, the server checks the database, and the payment routes
answer 503 until the migration is applied and `openreceive_on_paid` is
yours; the log names the fix. More: [Supabase over HTTPS](../guides/supabase.md#supabase-over-https).

## The checkout page

```tsx
// src/routes/checkout.$reference.tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/checkout/$reference")({
  component: OrderCheckout,
});

function OrderCheckout() {
  const { reference } = Route.useParams();
  return <Checkout reference={reference} prefix="/openreceive" />;
}
```

It renders on the server and starts the checkout in the browser. The payer
picks Bitcoin and gets the invoice.

## Settings

- `NWC_URI`: a receive-only code from your wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
  Optional: `LSC_URI_PRIMARY` for swaps
  ([set one up](https://openreceive.org/set_up_swap_provider)).
- `DATABASE_URL`: your Postgres. On serverless hosts use the pooled URL. The
  storage is tested through a transaction pooler.
- On Supabase over HTTPS, instead of `DATABASE_URL`: `SUPABASE_URL` and the
  secret key in `SUPABASE_SERVICE_ROLE_KEY`. Lovable sets both itself.

Set them as server secrets, never with a `VITE_` prefix, which would put them
in the browser bundle.

No worker or cron job is needed. Each request to the payment routes also
checks the wallet for settled invoices, through a lock in your database. A
payer who closes the tab is settled on the next request.
