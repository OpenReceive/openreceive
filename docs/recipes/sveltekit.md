# SvelteKit recipe

OpenReceive ships no SvelteKit package. A SvelteKit endpoint (`+server.ts`)
takes a Web-standard `Request` and returns a `Response`, and so does
`@openreceive/http`, so the integration is the route below. Your server code
creates each Lightning invoice, the payment goes straight to your wallet, and
payment attempts are stored in your app's database. There is no OpenReceive
account and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

This recipe was checked with `@sveltejs/kit` 3.0, `@sveltejs/adapter-node`
6.0 and `@openreceive/*` 0.4.25. The built app ran on Node in Docker, with
Postgres and a test wallet on a public NWC relay. In Chromium, the buyer's
checkout page showed the Lightning invoice. A stranger got 403 from the
payment routes and 404 from the page, and a request that named its own amount
got 400. When the wallet marked the invoice paid, the page showed it paid and
`onPaid` marked the order paid.

```sh
npm install @openreceive/http @openreceive/svelte pg
```

## Where it runs

On Node, with `@sveltejs/adapter-node`. The wallet connection and your
database driver need Node, so the route cannot run on an edge runtime. The
Vercel and Netlify adapters deploy Node functions: read
[Bitcoin checkout on serverless hosts](../guides/serverless.md) first. For
Cloudflare Workers, the [TanStack Start recipe](tanstack-start.md#where-it-runs)
explains what a Worker needs. This recipe was not run on those hosts.

## Secrets

SvelteKit 3 reads the environment variables you declare in `src/env.ts`. The
build runs your app to analyse it, without your secrets, so require them only
when the app starts:

```ts
// src/env.ts
import { building } from "$app/env";
import { defineEnvVars } from "@sveltejs/kit/env";

const secret = (value: string | undefined): string => {
  if (value) return value;
  if (building) return "";
  throw new Error("is not set");
};

export const variables = defineEnvVars({
  NWC_URI: { schema: secret, description: "Receive-only NWC code from your wallet" },
  DATABASE_URL: { schema: secret, description: "Postgres connection string" },
});
```

Never mark them `public: true`, which would send them to the browser.

## The payment route

Keep the handler under `src/lib/server/`. SvelteKit refuses to bundle a
module from there into browser code:

```ts
// src/lib/server/openreceive.ts
import { createStack, type Stack } from "@openreceive/http";
import type { RequestEvent } from "@sveltejs/kit";
import { NWC_URI } from "$app/env/private";
import { db } from "./db"; // your existing pg Pool
import { findOrder } from "./orders"; // your own orders

let stack: Stack | undefined;

// Built on the first request, not at import: the build imports server
// modules to analyse them, and a stack connects to the wallet at once.
function openReceive(): Stack {
  stack ??= createStack({
    wallet: { nwc: NWC_URI },
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
    authorize: async ({ native, resource }) => {
      const event = native as RequestEvent;
      const order = resource.reference ? await findOrder(resource.reference) : undefined;
      return Boolean(order && order.visitor === event.cookies.get("visitor"));
    },
    // adapter-node's client address: the socket, or ADDRESS_HEADER behind a proxy.
    rateLimiting: {
      ip: ({ native }) => (native as RequestEvent).getClientAddress(),
    },
  });
  return stack;
}

export function handleOpenReceive(event: RequestEvent): Promise<Response> {
  return openReceive().handler(event.request, { native: event });
}
```

```ts
// src/routes/openreceive/[...path]/+server.ts — every route under /openreceive/
import { handleOpenReceive } from "#lib/server/openreceive.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = (event) => handleOpenReceive(event);
export const POST: RequestHandler = (event) => handleOpenReceive(event);
```

`native` is the request's `RequestEvent`, so `authorize` can check the
session your app already has: its cookies, or the `event.locals.user` your
`hooks.server.ts` sets. The [Next.js quickstart](../guides/quickstart-next.md)
explains each hook. They are the same here.

One stack serves the whole server process. Behind a reverse proxy, set
adapter-node's `ADDRESS_HEADER` (and `XFF_DEPTH`), so that
`getClientAddress()` returns the payer's address and not the proxy's
([Rate limiting](../guides/rate-limiting.md)).

On SvelteKit 2, import the secret as `env.NWC_URI` from
`$env/dynamic/private`, and import server modules from `$lib/server/`, with
no `src/env.ts`. The rest is the same. This recipe was checked on SvelteKit 3
only.

## Your database

`db` is a `pg` Pool, `node:sqlite` or `better-sqlite3`, or one of the
adapters in [Node ORM recipes](../guides/node-orms.md). With Drizzle, pass
the driver underneath it. `sv add drizzle` sets up Postgres through
postgres.js or Neon, which OpenReceive does not take directly. Then give
OpenReceive its own small `pg` Pool on the same `DATABASE_URL`. It is the same
database, not a second one.

Create OpenReceive's two tables with your migrations
(`npx openreceive scaffold payments --orm drizzle` writes the Drizzle
schema), or run `paymentsSchemaSql("postgres")` from `@openreceive/http`
once. It is idempotent. See [Payment storage](../guides/storage.md).

## The checkout page

```ts
// src/routes/checkout/[reference]/+page.server.ts
import { error } from "@sveltejs/kit";
import { findOrder } from "#lib/server/orders.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, cookies }) => {
  const order = await findOrder(params.reference);
  if (!order || order.visitor !== cookies.get("visitor")) error(404);
  return { reference: order.id };
};
```

```svelte
<!-- src/routes/checkout/[reference]/+page.svelte -->
<script lang="ts">
  import Checkout from "@openreceive/svelte/checkout.svelte";
  import "@openreceive/svelte/styles.css";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<Checkout reference={data.reference} prefix="/openreceive" />
```

The page renders on the server and starts the checkout in the browser. The
payer picks Bitcoin and gets the invoice. Keep it at the order's own URL: a
payer with a swap deposit in flight comes back to it
([Swap refunds](../guides/swap-refunds.md)).

## Settings

- `NWC_URI`: a receive-only code from your wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
- `DATABASE_URL`: your Postgres. On serverless hosts use the pooled URL.
- Optional: `LSC_URI_PRIMARY` for swaps
  ([set one up](https://openreceive.org/set_up_swap_provider)), and
  `LSC_URI_BACKUP`. OpenReceive reads these, and `LOG_LEVEL`, straight from
  `process.env`, not through `src/env.ts`.

In production, set them all in the server's environment. In development,
`vite dev` reads `.env` for the variables in `src/env.ts` but keeps the file
out of `process.env`. To try swaps locally, start it with
`node --env-file=.env node_modules/.bin/vite dev`.

No worker or cron job is needed. Each request to the payment routes also
checks the wallet for settled invoices, through a lock in your database. A
payer who closes the tab is settled on the next request.
