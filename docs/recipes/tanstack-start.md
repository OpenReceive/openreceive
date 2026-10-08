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
Lightning invoice, and a stranger was refused.

```sh
npm install @openreceive/http @openreceive/react pg
```

## Where it runs

- **Node** (the `node-server` preset, or any Node host): any Postgres.
- **Cloudflare Workers** (the `cloudflare-module` preset, Lovable's default):
  with Node compatibility, and a Postgres whose certificate a public
  authority signed, such as Neon. Supabase's is not: see
  [Supabase](../guides/supabase.md#where-your-server-can-run).

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

Set them as server secrets, never with a `VITE_` prefix, which would put them
in the browser bundle.

No worker or cron job is needed. Each request to the payment routes also
checks the wallet for settled invoices, through a lock in your database. A
payer who closes the tab is settled on the next request.
