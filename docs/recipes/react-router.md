# React Router recipe

OpenReceive ships no React Router package. In React Router's framework mode
(formerly Remix), a resource route's `loader` and `action` take a
Web-standard `Request` and can return a `Response`, and so does
`@openreceive/http`, so the integration is the route below. Your server code
creates each Lightning invoice, the payment goes straight to your wallet, and
payment attempts are stored in your app's database. There is no OpenReceive
account and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

This recipe was checked with `react-router` 8.4 (the default template, with
Tailwind) and `@openreceive/*` 0.4.25. The built app ran on Node in Docker
(`react-router-serve`), with Postgres and a test wallet on a public NWC
relay. In Chromium, the buyer's checkout page showed the Lightning invoice. A
stranger got 403 from the payment routes and 404 from the page, and a request
that named its own amount got 400. When the wallet marked the invoice paid,
the page showed it paid and `onPaid` marked the order paid.

```sh
npm install @openreceive/http @openreceive/react pg
```

## Where it runs

On Node, with `react-router-serve` or your own Express server. The wallet
connection and your database driver need Node, so the route cannot run on an
edge runtime. On Vercel or Netlify, read
[Bitcoin checkout on serverless hosts](../guides/serverless.md) first. For
Cloudflare Workers, the [TanStack Start recipe](tanstack-start.md#where-it-runs)
explains what a Worker needs. This recipe was not run on those hosts.

## The payment route

Keep the handler in a `.server.ts` module. React Router refuses to bundle one
into browser code:

```ts
// app/lib/openreceive.server.ts
import { createStack, type Stack } from "@openreceive/http";
import { db } from "./db.server"; // your existing pg Pool
import { currentVisitor, findOrder } from "./orders.server"; // your own orders

let stack: Stack | undefined;

// Built on the first request, not at import, so the build never connects
// to the wallet.
function openReceive(): Stack {
  stack ??= createStack({
    wallet: { nwc: process.env.NWC_URI ?? "" },
    storage: {
      db,
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
      const order = await findOrder(reference);
      return order?.state === "awaiting_payment"
        ? { currency: order.currency, value: order.amount, description: order.title }
        : null;
    },
    // Only the buyer may pay for their order.
    authorize: async ({ request, resource }) => {
      const order = resource.reference ? await findOrder(resource.reference) : undefined;
      const visitor = await currentVisitor(request);
      return Boolean(order && visitor && order.visitor === visitor);
    },
    // A loader sees no socket address. Read the header your reverse proxy
    // sets and overwrites; never one a client can send through it.
    rateLimiting: {
      ip: ({ request }) => request.headers.get("x-real-ip") ?? undefined,
    },
  });
  return stack;
}

export function handleOpenReceive(request: Request): Promise<Response> {
  return openReceive().handler(request);
}
```

```ts
// app/routes/openreceive.ts
import { handleOpenReceive } from "~/lib/openreceive.server";
import type { Route } from "./+types/openreceive";

// A resource route: no component, so React Router returns these Responses as-is.
export const loader = ({ request }: Route.LoaderArgs) => handleOpenReceive(request);
export const action = ({ request }: Route.ActionArgs) => handleOpenReceive(request);
```

```ts
// app/routes.ts
import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("openreceive/*", "routes/openreceive.ts"), // every route under /openreceive/
  route("checkout/:reference", "routes/checkout.tsx"),
] satisfies RouteConfig;
```

`authorize` sees the incoming request with its cookies, so check it with the
session your app already has. With `createCookieSessionStorage`,
`currentVisitor` is `(await getSession(request.headers.get("cookie"))).get("visitor")`.
The [Next.js quickstart](../guides/quickstart-next.md) explains each hook.
They are the same here.

One stack serves the whole server process. A loader cannot see the
connection, so the client address comes from a header. Without a proxy that
sets it, the limit does not apply ([Rate limiting](../guides/rate-limiting.md)).

## Your database

`db` is a `pg` Pool, `node:sqlite` or `better-sqlite3`, or one of the
adapters in [Node ORM recipes](../guides/node-orms.md). With Drizzle, pass
the `pg` Pool underneath it.

Create OpenReceive's two tables with your migrations
(`npx openreceive scaffold payments --orm <your orm>`), or run
`paymentsSchemaSql("postgres")` from `@openreceive/http` once. It is
idempotent. See [Payment storage](../guides/storage.md).

## The checkout page

```tsx
// app/routes/checkout.tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";
import { data } from "react-router";
import { currentVisitor, findOrder } from "~/lib/orders.server";
import type { Route } from "./+types/checkout";

export async function loader({ params, request }: Route.LoaderArgs) {
  const order = await findOrder(params.reference);
  if (!order || order.visitor !== (await currentVisitor(request))) {
    throw data("Not found", { status: 404 });
  }
  return { reference: order.id };
}

export default function OrderCheckout({ loaderData }: Route.ComponentProps) {
  return <Checkout reference={loaderData.reference} prefix="/openreceive" />;
}
```

Import `styles.css` from the route module, as above. Do not `@import` it
into your Tailwind entry (`app/app.css`); the checkout styles are compiled
already. The page renders on the server and starts the checkout in the
browser. The payer picks Bitcoin and gets the invoice. Keep it at the order's
own URL: a payer with a swap deposit in flight comes back to it
([Swap refunds](../guides/swap-refunds.md)).

## Settings

- `NWC_URI`: a receive-only code from your wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
- `DATABASE_URL`: your Postgres. On serverless hosts use the pooled URL.
- Optional: `LSC_URI_PRIMARY` for swaps
  ([set one up](https://openreceive.org/set_up_swap_provider)), and
  `LSC_URI_BACKUP`.

The route reads them from `process.env` when the first request arrives.
`react-router dev` loads `.env` into `process.env`. In production, set them
in the server's environment: `react-router-serve` does not read `.env`. Never
give them a `VITE_` prefix, which would put them in the browser bundle.

No worker or cron job is needed. Each request to the payment routes also
checks the wallet for settled invoices, through a lock in your database. A
payer who closes the tab is settled on the next request.
