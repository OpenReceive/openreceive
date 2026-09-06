# Next.js quickstart

Next.js App Router + React. Requires Node ≥ 22 and Next ≥ 15 (App Router).

## 1. Install

```sh
npm install @openreceive/next @openreceive/react
```

Install the adapter for your server and the UI package for your frontend; the
wallet client, HTTP handler, and contracts come along as dependencies. The
`openreceive` package is the CLI only — `npx openreceive …` below needs no
install. Different stack? Swap the two packages; the rest of this guide is
identical.

|          | Packages                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Server   | `@openreceive/next`, `@openreceive/express`, `@openreceive/fastify`                                                           |
| Frontend | `@openreceive/react`, `@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular`, `@openreceive/elements` (plain HTML) |

Express: [quickstart-node.md](quickstart-node.md) · Fastify:
[quickstart-fastify.md](quickstart-fastify.md). This page is the Next.js one,
and it is where an agent handed the Express guide goes wrong: no `dotenv`, no
`app.use`, a client component for the checkout.

On a fresh project, the App Router is what `create-next-app` scaffolds; no
env loader is needed (Next loads `.env.local` itself). Install your ORM
before step 2 (`npm install prisma @prisma/client` on the Prisma path) —
`openreceive scaffold` emits files for the ORM you name but never installs it.

<!-- shared:begin install-notes -->
npm environments that run with `ignore-scripts` (some editor sandboxes) skip
Prisma's engine download and esbuild's binary postinstall, so a typecheck or
build that fails only there is environmental, not a code problem.
<!-- shared:end install-notes -->

<!-- shared:begin migrate -->
## 2. Migrate the payment tables

```sh
npx openreceive scaffold payments --orm prisma   # or drizzle | typeorm | sequelize | knex
```

`openreceive scaffold payments` emits one schema/migration file for your ORM
and a wiring guide. It never touches a database.
→ [openreceive scaffold payments](api-reference.md#openreceive-scaffold-payments)

Then run the emitted migration through your normal workflow (for example
`npx prisma migrate dev`). OpenReceive owns the tables' logic at runtime; there
is nothing else to generate. Details:
[Payment storage](storage.md), [Node ORM recipes](node-orms.md).

No ORM? A bare driver handle (`pg`, `node:sqlite`, `better-sqlite3`) is a
supported `db` in step 4, and there is no scaffold flavor for it — execute the
same DDL once yourself with `paymentsSchemaSql(dialect)` from
`@openreceive/http` instead of scaffolding.
<!-- shared:end migrate -->

## 3. Add wallet credentials

Create a server-only `.env.local` (Next loads it into `process.env` on its
own — do **not** add `dotenv`, and never prefix these with `NEXT_PUBLIC_`,
which would inline them into the browser bundle):

<!-- shared:begin credentials -->
```dotenv
NWC_URI=
LSC_URI_PRIMARY=
LSC_URI_BACKUP=
```

1. Get a receive-only NWC code from a compatible wallet
   ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments))
   → `NWC_URI`.
2. Optionally set up a [swap provider](https://openreceive.org/set_up_swap_provider)
   → `LSC_URI_PRIMARY` (and `LSC_URI_BACKUP` if you have one).

Never put these values in browser code. Your application refuses to start if
the NWC code also advertises spend methods such as `pay_invoice`; mint a
receive-only code ([Security](security.md)).
<!-- shared:end credentials -->

In production supply the same variables through your host's secret manager or
process environment; `.env.local` is for development and is gitignored by
`create-next-app`. → [Environment variables](environment-variables.md).

## 4. Wire OpenReceive

One catch-all route file: your hooks plus a database handle. The adapter
builds the wallet client and the host and returns the `GET`/`POST` exports the
App Router expects; there is no background reconciler — settlement piggybacks
on requests through the durable gate, which is what makes it serverless-safe.

```ts
// app/openreceive/[...openreceive]/route.ts
import { openReceiveNextHandlers } from "@openreceive/next";
import { db, orders, sessions } from "@/lib/app"; // your existing database handle and models

// The wallet relay and your database driver need Node, never the Edge runtime,
// and a payment route must never be cached or statically rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = openReceiveNextHandlers({
  wallet: { nwc: process.env.NWC_URI! }, // receive-only NWC code; your app refuses to start otherwise
  storage: {
    db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
    onPaid: async ({ reference, paidAt, query }) => {
      // Settlement transaction; runs only for the first settled attempt for a
      // reference. The WHERE clause is the lock: a second fulfillment path of
      // yours (admin action, replayed job) updates zero rows and does nothing.
      // Use `query` here, not your ORM's other connection. `?` on sqlite, `$1`
      // on postgres.
      const claimed = await query(
        "UPDATE orders SET state = 'paid', paid_at = ? WHERE id = ? AND state = 'awaiting_payment' RETURNING id",
        [paidAt, reference],
      );
      if (claimed.length === 0) return;
    },
  },
  // The price for a reference — here, your order id — from your own data;
  // OpenReceive converts it into the Lightning invoice. Return null when
  // there is nothing to pay for. `value` is a decimal STRING from the order
  // row, never a float and never a request param. `description` is what the
  // payer is buying, in your own words.
  amountFor: async (reference) => {
    const order = await orders.find(reference);
    return order
      ? {
          currency: "USD",
          value: order.total.toString(),
          description: `${order.lines.length} items`,
        }
      : null;
  },
  // Your own access check: may this caller do this action to this reference?
  // `resource.reference` is your own order id, sent back by the payer's
  // browser — a claim, not proof — already validated as a non-empty string.
  // `request` is the Web Request; read cookies or headers from it the way you
  // would in any route handler (`native` is the same NextRequest).
  authorize: async ({ action, request, resource }) =>
    orders.viewerMay(
      await sessions.currentUser(request),
      resource.reference,
      action,
    ),
  // Recommended for public web shops: caps invoice creation at 60 per client IP
  // per hour. A web Request has no socket IP, so on Next this ALSO needs an
  // IP source: `trustProxyIpHeader: true` reads the first hop of
  // x-forwarded-for, which is safe only when YOUR reverse proxy or hosting
  // platform sets it (Vercel, Cloudflare and most load balancers do). Without
  // an IP source the adapter refuses to construct rather than run an
  // inactive limiter. Leave both off for point-of-sale deployments, where
  // many payers share the terminal's IP.
  rateLimiting: true,
  trustProxyIpHeader: true,
});
```

The route file is a **server module** — it imports your database handle and
reads `process.env`, and nothing in it may be imported from a client
component. The default prefix is `/openreceive`, which is the directory the
file sits in; put the catch-all under another directory and pass `prefix` to
match.

When the options are themselves async (a database opened lazily, a wallet
client shared with a worker), build the handlers per request instead of at
module load — the Buy a Button example does exactly this:

```ts
async function handle(request: Request): Promise<Response> {
  const { GET, POST } = openReceiveNextHandlers(await httpOptions());
  return request.method === "GET" ? GET(request) : POST(request);
}
export { handle as GET, handle as POST };
```

The first request checks the wallet. Later OpenReceive requests also settle
pending invoices, so a payer who closes the tab is still covered.
`authorize` runs on every request.
→ [openReceiveNextHandlers](api-reference.md#openreceivenexthandlers) ·
[authorize context](api-reference.md#the-authorize-context)

`rateLimiting: true` is for public web shops. Leave it off for point-of-sale,
where many payers share one IP. → [Rate limiting](rate-limiting.md)

An optional worker, `startNotificationWorker({ service, host })`, listens for
wallet payment notifications so settlement does not wait for the next page
load. It is a separate long-lived Node process, not a route — on a serverless
host, skip it and rely on the request-path settlement above.
→ [startNotificationWorker](api-reference.md#startnotificationworker)

Composing the pieces yourself (`createOpenReceive` + `createHost`) is
supported when you need a shared wallet client or a custom repository.
→ [createOpenReceive](api-reference.md#createopenreceive) ·
[createHost](api-reference.md#createhost)

<!-- shared:begin reference -->
Your app also needs an ordinary order-creation route that validates the cart,
prices with exact decimal math, and returns the order id the page will pass as
the `reference`. OpenReceive never prices from payer input.

The `reference` is a string you choose, and it is the fulfillment identity:
your order id — one per thing you fulfill, created before checkout, kept
across retries, never reused. OpenReceive never looks inside it, but `onPaid`
runs once per reference, a new checkout under a reference that already
settled is refused with 409, and a fresh id per page load lets one order be
paid twice.

Naming boundary: TypeScript APIs use camelCase fields (`paymentHash`,
`amountMsats`); everything on the wire — the mounted HTTP routes and the
browser snapshots — is snake_case (`payment_hash`, `amount_msats`).
<!-- shared:end reference -->

## 5. Render checkout

`<Checkout>` polls and holds state, so it is a **client component**. Put it in
a file that starts with `"use client"` and import the stylesheet from that
same module; the page that renders it can stay a server component.

```tsx
// app/checkout/[reference]/order-checkout.tsx
"use client";

import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

export function OrderCheckout({ reference }: { reference: string }) {
  return <Checkout reference={reference} prefix="/openreceive" />;
}
```

```tsx
// app/checkout/[reference]/page.tsx — the order's own, resumable URL
import { OrderCheckout } from "./order-checkout";

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;
  return <OrderCheckout reference={reference} />;
}
```

`/checkout/[reference]` is deliberately a page of its own rather than a modal
on the cart: a payer with a swap deposit in flight has no account and no email
from you, so this URL is the only thing that brings them back to their payment
— it has to survive a reload and a bookmark
([Swap refunds](swap-refunds.md)). Do not render the checkout for a
reference the current session may not see; the page can read the session and
404 before it renders, and `authorize` refuses the routes regardless.

The checkout renders, polls, and settles itself. The compiled `styles.css`
sheets (`@openreceive/react`, `@openreceive/elements`) are self-contained and
scoped: every rule applies only inside what OpenReceive renders, so the sheet
is safe next to any CSS framework (Tailwind, Mantine, your own reset) in any
import order. No `transpilePackages` entry is needed; the packages ship plain
ESM.

<!-- shared:begin render-notes -->
`<Checkout>` is complete as rendered: it already shows the `description` from
`amountFor` and the collapsed transaction-details panel. Do not build a custom
UI to satisfy those rules — they only become your job if you replace the
drop-in ([Checkout UX](checkout-ux.md)).

Match the host page's theme: by default the checkout follows the payer's
stored choice, then the system scheme. If this page is always one theme, lock
it — `<Checkout theme="dark" … />` (`theme` attribute on the custom element) —
so a white card never lands on a dark page. The checkout is styled by CSS
variables under `data-theme`; [Frontend checkout](frontend-checkout.md) has
the knobs.

The payment-method icons are compiled into `@openreceive/browser` and need
nothing from your bundler. The wallet logos and pay tutorials are files in
`@openreceive/provider-data`, and outside Vite/Rollup (esbuild, webpack, a
plain script tag) they cannot resolve their own URLs — the drop-in needs this
exactly as a custom UI does. Serve that package's `dist/assets` tree and pass
the base as `assetBaseUrl="/openreceive-assets"`
([Provider registry](provider-registry.md#assets)).

That is the whole loop: your server owns the price and the order, the payer gets
an invoice, and `onPaid` runs once inside the settlement transaction.
<!-- shared:end render-notes -->

A runnable illustration of this boundary — not a template to copy models from —
is Buy a Button
([`examples/buttons/server/nextjs-fullstack`](../../examples/buttons/server/nextjs-fullstack)).
It has products, visitors, and orders, with the three hooks as the only bridge,
its shop routes as three-line App Router wrappers, and `/checkout/[reference]`
as the resumable page. Map that shape onto the models in THIS app.

<!-- shared:begin verify -->
## 6. Verify

```sh
npx openreceive doctor
```

`openreceive doctor` checks Node, `NWC_URI`, and swap-provider configuration,
and probes the wallet relay to confirm the code is receive-only. Add
`--db <file-or-url>` to confirm the migration ran, and
`--url http://localhost:3000` to confirm the routes are mounted; every failing
line states its own fix.
→ [openreceive doctor](api-reference.md#openreceive-doctor)
<!-- shared:end verify -->

<!-- shared:begin next -->
## Next

- [Authorization](authorization.md) — your policy boundary
- [Payment storage](storage.md) — the library-owned table and state machine
- [Frontend Checkout](frontend-checkout.md) — browser responsibilities
- [Automated Swaps](automated-swaps.md) — `swap_data`, and what turning swaps on commits you to
- [Swap refunds](swap-refunds.md) — the refund flow, and the per-order URL a payer needs to come back and use it. Read it before setting `LSC_URI_PRIMARY`
- [Security](security.md) — server-only secret boundaries

More on wiring, storage, and routes:
[Authorization](authorization.md), [Payment storage](storage.md),
[API reference](api-reference.md).
<!-- shared:end next -->
