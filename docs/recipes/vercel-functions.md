# Vercel Functions recipe

For a site on Vercel with no framework: plain JavaScript functions under
`api/`, and static HTML pages. A Vercel Function can take a Web-standard
`Request` and return a `Response`, and so can `@openreceive/http`, so the
integration is one function, one rewrite and an element on the order page.
Your server code creates each Lightning invoice, the payment goes straight to
your wallet, and payment attempts are stored in your Postgres database. There
is no OpenReceive account, no API key and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

This recipe was checked on Vercel with Fluid compute, Node 24, a Neon
database and `@openreceive/*` 0.5.0: a buyer got a real Lightning invoice, a
stranger got 403, three requests at once left one live invoice, and a paid
invoice marked the order paid once. The function below runs in OpenReceive's
CI on every change, through PgBouncer in transaction mode, as Neon's pooler
works.

```sh
npm install @openreceive/http @openreceive/elements pg @vercel/functions
```

## Where it runs

- **On the Node runtime**, Node 22 or newer. Never `runtime: "edge"`: the
  wallet connection and `pg` need Node.
- **As ES modules.** The packages are ESM only: set `"type": "module"` in
  `package.json`, or name the files `.mjs`.
- **Postgres, shared by every instance.** Vercel runs many instances of a
  function, and each has its own short-lived disk, so SQLite cannot work.
  Neither can a KV store or Redis. If the project has no Postgres, add Neon
  from the project's **Storage** tab. Its free plan is enough. Neon sets
  `DATABASE_URL`, a pooled URL for the app, and `DATABASE_URL_UNPOOLED`, a
  direct URL for creating tables.
- **No cron job or worker required.** Each request to the payment routes also
  checks the wallet for settled invoices, through a lock in your database, so
  a payer who closes the tab is settled on the next request from anyone.
  On a quiet site that can be hours later. If fulfillment should not wait,
  see [When the payer leaves the page](../guides/deploying.md#when-the-payer-leaves-the-page).
- **Pages in `public/`.** With no `public/` folder, Vercel serves every file
  in the project's root, your server modules in `lib/` included. The codes
  stay in environment variables either way, but keeping the pages in
  `public/` keeps the rest of the code private.

## The routes: one function and a rewrite

Every payment route sits under `/openreceive/`: `/openreceive/checkouts`,
`/openreceive/checkouts/prepare`, `/openreceive/payments/check`,
`/openreceive/swaps/status` and a few more. One function serves them all,
through a rewrite:

```json
{
  "rewrites": [{ "source": "/openreceive/:path*", "destination": "/api/openreceive" }],
  "functions": { "api/openreceive.js": { "maxDuration": 30 } }
}
```

Add both entries to `vercel.json`, beside any it already has. The request the
function receives still carries the path the browser asked for, such as
`/openreceive/checkouts/prepare` (Vercel appends the matched part as a
`path` query parameter, which the routes ignore), so the handler routes it
as is.

Outside Next.js, a file named `api/openreceive/[...path].js` is not a
catch-all: it matches one path segment, so `/checkouts/prepare` would get
Vercel's 404 page. Use the rewrite.

`maxDuration: 30` gives a request time to reach the wallet and, now and
then, to scan it for payments, which OpenReceive cuts off at 9 seconds. With
Fluid compute the default is already longer; without it, the Hobby plan's
default is 10 seconds.

## The payment function

```js
// lib/db.js — one small pool per function instance
import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";

// Neon's pooled URL. Vercel sets DATABASE_URL in every environment.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
// Closes idle connections before Vercel suspends the instance.
attachDatabasePool(pool);
```

```js
// api/openreceive.js — every route under /openreceive/, through the rewrite
import { createStack } from "@openreceive/http";
import { pool } from "../lib/db.js";
import { findOrder, visitorFrom } from "../lib/orders.js"; // your own orders

let stack;

// Built on the first request, then kept for the instance's later requests.
// createStack connects to the wallet as soon as it is built, and Vercel can
// load a function well before a request arrives, so never build it at import.
function openReceive() {
  stack ??= createStack({
    wallet: { nwc: process.env.NWC_URI ?? "" },
    storage: {
      db: pool,
      // Runs once, inside the transaction that records the payment. paidAt is
      // Unix seconds: for a timestamptz column, write to_timestamp($1).
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
      const visitor = visitorFrom(request);
      return Boolean(order && visitor && order.visitor === visitor);
    },
    // Vercel replaces any x-forwarded-for a client sends, so its first
    // address is the payer's.
    rateLimiting: {
      ip: ({ request }) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    },
  });
  return stack;
}

export function GET(request) {
  return openReceive().handler(request);
}

export function POST(request) {
  return openReceive().handler(request);
}
```

`findOrder` and `visitorFrom` are your own code: read the order row, and
the buyer from the request's cookie or session. The function's exports take
a `Request`. If your other functions use the older `(req, res)` form, keep
them as they are: each file picks its own form.

The [Next.js quickstart](../guides/quickstart-next.md) explains each hook.
They are the same here.

### A guest checkout

With no logins, give the buyer a cookie when your own code creates the order,
and keep the same value on the order row. Sign it with your app's own secret
(such as `SESSION_SECRET`), never with `NWC_URI`, and make it last: a payer
with a swap refund comes back hours later, and `authorize` must still know
them ([Swap refunds](../guides/swap-refunds.md)).

```js
// lib/orders.js — reading the buyer back from a signed cookie
import { createHmac, timingSafeEqual } from "node:crypto";

const sign = (value) =>
  createHmac("sha256", process.env.SESSION_SECRET).update(value).digest("base64url");

export function visitorCookie(visitor) {
  return `visitor=${visitor}.${sign(visitor)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}

export function visitorFrom(request) {
  const pair = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("visitor="));
  const [visitor, signature] = (pair?.slice("visitor=".length) ?? "").split(".");
  if (!visitor || !signature) return undefined;
  const expected = Buffer.from(sign(visitor));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected) ? visitor : undefined;
}
```

## Your database

Create OpenReceive's two tables, `openreceive_payments` and
`openreceive_meta`, with your migrations, or from the build step over the
direct URL. `paymentsSchemaSql` is idempotent, so it can run on every deploy:

```js
// scripts/openreceive-tables.mjs — run from "build" in package.json
import { paymentsSchemaSql } from "@openreceive/http";
import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
});
await client.connect();
try {
  await client.query(paymentsSchemaSql("postgres"));
} finally {
  await client.end();
}
```

Your orders stay in your own tables. OpenReceive reads the price through
`amountFor` and marks the order paid through `onPaid`, and it never joins
your tables.

### Orders that are not in Postgres

Some sites keep orders in Stripe, Airtable, a JSON file or a KV store. The
payment rows still need Postgres: add Neon for them. `amountFor` and `onPaid`
can reach your orders wherever they live. In `onPaid`, call your order store
after the database writes; `query` is only for SQL in the same database. Mark
the order paid only once: check its state first, since `onPaid` runs again if
your store failed the first time.

## The checkout page

The page needs no bundler. `@openreceive/elements` ships a standalone build:
copy its two files to where your site serves static files, in the same
build step:

```json
{
  "scripts": {
    "build": "node scripts/openreceive-tables.mjs && mkdir -p public/openreceive-checkout && cp node_modules/@openreceive/elements/dist/standalone/openreceive-checkout.js node_modules/@openreceive/elements/dist/standalone/openreceive-checkout.css public/openreceive-checkout/"
  }
}
```

Use `public/` if the site serves its static files from there, and the
project's root otherwise. Then put the element on the order's own page, with
the order's id as `reference`:

```html
<link rel="stylesheet" href="/openreceive-checkout/openreceive-checkout.css" />
<script type="module" src="/openreceive-checkout/openreceive-checkout.js"></script>

<openreceive-checkout reference="ORDER_ID" prefix="/openreceive" resumable></openreceive-checkout>
```

A function that renders the page writes the id in. A static page can set it
from its own address, such as `/order.html?id=…`:

```html
<script type="module">
  const checkout = document.querySelector("openreceive-checkout");
  checkout.setAttribute("reference", new URLSearchParams(location.search).get("id"));
</script>
```

The payer picks Bitcoin and gets the invoice. Keep the page at the order's
own URL: a payer with a swap deposit in flight comes back to it
([Swap refunds](../guides/swap-refunds.md)).

### The way back to a swap refund

With swaps on, a deposit that arrives short or late is refunded on a later
visit, often from another device. Keep the swap's payment hash on the order
row: add a `swap_payment_hash TEXT` column, and a function that saves it for
the order's own buyer:

```js
// api/order-swap.js — keeps the swap's payment hash on the order
import { pool } from "../lib/db.js";
import { findOrder, visitorFrom } from "../lib/orders.js";

export async function POST(request) {
  const { reference, payment_hash: paymentHash } = await request.json();
  const order = typeof reference === "string" ? await findOrder(reference) : undefined;
  const visitor = visitorFrom(request);
  if (!order || !visitor || order.visitor !== visitor || !/^[0-9a-f]{64}$/.test(paymentHash)) {
    return new Response(null, { status: 403 });
  }
  await pool.query("UPDATE orders SET swap_payment_hash = $1 WHERE id = $2", [
    paymentHash,
    order.id,
  ]);
  return new Response(null, { status: 204 });
}
```

The page sends the hash when a swap starts, and writes a saved one back as
`resume-payment-hash`, which reopens that swap instead of the payment
methods:

```html
<openreceive-checkout reference="ORDER_ID" prefix="/openreceive" resumable
  resume-payment-hash="SAVED_HASH"></openreceive-checkout>
<script type="module">
  const checkout = document.querySelector("openreceive-checkout");
  checkout.addEventListener("openreceive-state", (event) => {
    const { state } = event.detail;
    if (state.rail !== "swap" || !state.payment_hash) return;
    fetch("/api/order-swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: checkout.getAttribute("reference"), payment_hash: state.payment_hash }),
    });
  });
</script>
```

Leave `resume-payment-hash` out while the order has none. The checkout ignores
a hash the server will not serve, so a stale one does no harm.

## Settings

In the project's **Settings** → **Environment Variables**, as **Secret**, for
Production, Preview and Development:

- `NWC_URI`: a receive-only code from your wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
- Optional: `LSC_URI_PRIMARY` for swaps
  ([set one up](https://openreceive.org/set_up_swap_provider)), and
  `LSC_URI_BACKUP`.
- `DATABASE_URL` and `DATABASE_URL_UNPOOLED`, which Neon adds itself.

OpenReceive reads `LSC_URI_PRIMARY` and `LSC_URI_BACKUP` from the environment
itself, so `createStack` takes only the wallet code. Keep them all out of
`vercel.json`, the code and the logs. Vercel gives a
deployment the variables of its environment, so a code added later reaches
only the deploys after it: redeploy.

## Check it

On a preview or production deploy, a stranger asking for a real order must
get OpenReceive's JSON refusal, not Vercel's 404 page:

```sh
curl -s -X POST https://<your-deployment>/openreceive/checkouts/prepare \
  -H 'content-type: application/json' -d '{"reference":"<a real order id>"}'
```

It answers `403` with `"code":"FORBIDDEN"`. Vercel's `NOT_FOUND` page means
the rewrite is missing. Then, as the buyer, open the order's page: it shows
the payment methods and, after you pick Bitcoin, a Lightning invoice.

A preview deployment behind Vercel Authentication answers `401` to `curl`.
Check that one in the browser where you are signed in to Vercel, or on the
production domain.

## Next

- To have a coding agent do this, give it the
  [Vercel Functions agent directions](https://openreceive.org/agent-directions/vercel-functions.md):
  this recipe in full, plus the steps an agent gets wrong.
- [Bitcoin checkout on Vercel Functions](../guides/vercel-functions.md): the
  guide, with a prompt to paste into your coding agent.
