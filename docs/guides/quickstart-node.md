# Node quickstart (Express)

Express + React. Requires Node ≥ 22.

## 1. Install

```sh
npm install @openreceive/express @openreceive/react
```

Install the adapter for your server and the UI package for your frontend. The
wallet client, HTTP handler, and contracts come along as dependencies. The
`openreceive` package is only the CLI, and `npx openreceive …` below needs no
install. On a different stack, swap the two packages; the rest of this guide
stays the same.

|          | Packages                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Server   | `@openreceive/express`, `@openreceive/fastify`, `@openreceive/next`                                                           |
| Frontend | `@openreceive/react`, `@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular`, `@openreceive/elements` (plain HTML) |

Fastify: [quickstart-fastify.md](quickstart-fastify.md) · Next.js:
[quickstart-next.md](quickstart-next.md). This page is the Express one.

On a fresh project, also install what this guide assumes you already have: the
framework and an env loader (`npm install express dotenv`). Install your ORM
before step 2 too (`npm install prisma @prisma/client` on the Prisma path).
`openreceive scaffold` emits files for the ORM you name, but it never installs
that ORM.

<!-- shared:begin install-notes -->
Some editor sandboxes run npm with `ignore-scripts`. That setting skips
Prisma's engine download and esbuild's binary postinstall. If a typecheck or
build fails only in such an environment, the environment is the cause, not
your code.
<!-- shared:end install-notes -->

<!-- shared:begin migrate -->
## 2. Migrate the payment tables

```sh
npx openreceive scaffold payments --orm prisma   # or drizzle | typeorm | sequelize | knex
```

`openreceive scaffold payments` writes one schema or migration file for your
ORM, plus a wiring guide. It never touches a database.
→ [openreceive scaffold payments](api-reference.md#openreceive-scaffold-payments)

Then run the generated migration the way you normally do (for example
`npx prisma migrate dev`). OpenReceive runs the tables' logic at runtime, so
there is nothing else to generate. Details:
[Payment storage](storage.md), [Node ORM recipes](node-orms.md).

No ORM? You can pass a bare driver handle (`pg`, `node:sqlite`,
`better-sqlite3`) as the `db` in step 4. The scaffold has no flavor for it.
Instead of scaffolding, run the same DDL once yourself, using
`paymentsSchemaSql(dialect)` from `@openreceive/http`.
<!-- shared:end migrate -->

## 3. Add wallet credentials

Create a server-only `.env`:

<!-- shared:begin credentials -->
```dotenv
NWC_URI=
LSC_URI_PRIMARY=
LSC_URI_BACKUP=
```

1. Get a receive-only NWC code from a compatible wallet
   ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
   Put it in `NWC_URI`.
2. Optional: set up a [swap provider](https://openreceive.org/set_up_swap_provider).
   Put its connection string in `LSC_URI_PRIMARY`, and a second one in
   `LSC_URI_BACKUP` if you have one.

Never put these values in browser code. Your app refuses to start if the NWC
code also advertises spend methods such as `pay_invoice`. Create a
receive-only code instead ([Security](security.md)).
<!-- shared:end credentials -->

OpenReceive reads `process.env`, so creating a `.env` file is not enough on
its own. [Environment variables](environment-variables.md) explains how that
file or your production secrets get into the process: `dotenv` on
Express/Fastify, auto-load on Next.js, and secret managers in production.

## 4. Wire OpenReceive

One factory call takes your hooks and a database handle. The adapter builds
the wallet client and the host. There is no background reconciler, meaning no job that checks pending
payments on a timer. Settlement runs during normal requests instead, through
the durable reconcile gate.

```ts
import "dotenv/config"; // loads .env into process.env; nothing else does
import express from "express";
import { openReceiveExpress } from "@openreceive/express";
import { db, orders, sessions } from "./app.ts"; // your existing database handle and models

const app = express();
app.use(express.json());
const openreceive = openReceiveExpress({
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
  authorize: async ({ action, request, resource }) =>
    orders.viewerMay(
      await sessions.currentUser(request),
      resource.reference,
      action,
    ),
  // Recommended for public web shops: caps invoice creation at 60 per client IP
  // per hour. Leave it off (the default) for point-of-sale deployments, where
  // many payers share the terminal's IP.
  rateLimiting: true,
});
// Behind a reverse proxy or load balancer, rate limiting needs the real client
// IP — without this every payer shares the proxy's IP and one abuser can lock
// checkout for everyone. Delete the line only if the app faces the network
// directly (see the rate-limiting guide).
app.set("trust proxy", 1);
app.use(openreceive);
```

The first request checks the wallet. Later OpenReceive requests also settle
pending invoices, so a payer who closes the tab is still covered.
`authorize` runs on every request.
→ [openReceiveExpress](api-reference.md#openreceiveexpress) ·
[authorize context](api-reference.md#the-authorize-context)

`rateLimiting: true` is for public web shops. Leave it off for point-of-sale,
where many payers share one IP. → [Rate limiting](rate-limiting.md)

An optional worker, `startNotificationWorker({ service, host })`, listens for
wallet payment notifications so settlement does not wait for the next page
load. → [startNotificationWorker](api-reference.md#startnotificationworker)

You can also compose the pieces yourself (`createOpenReceive` + `createHost`)
when you need a shared wallet client or a custom repository.
→ [createOpenReceive](api-reference.md#createopenreceive) ·
[createHost](api-reference.md#createhost)

<!-- shared:begin reference -->
Your app also needs an ordinary route that creates the order. It validates the
cart, computes the price with exact decimal math, and returns the order id.
The page passes that id as the `reference`. OpenReceive never takes a price
from payer input.

The `reference` is a string you choose, and it identifies what gets fulfilled.
Use your order id. Make it:

- one per thing you fulfill,
- created before checkout,
- kept across retries,
- never reused.

OpenReceive never looks inside the `reference`, but it relies on it:

- `onPaid` commits fulfillment once per reference.
- A new checkout under a reference that already settled is refused with 409.
- A fresh id on every page load would let one order be paid twice.

Naming boundary: TypeScript APIs use camelCase fields (`paymentHash`,
`amountMsats`). Everything on the wire is snake_case (`payment_hash`,
`amount_msats`). The wire means the mounted HTTP routes and the browser
snapshots.
<!-- shared:end reference -->

<!-- shared:begin render -->
## 5. Render checkout

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout reference={order.id} prefix="/openreceive" />;
```

The checkout renders, polls, and settles itself.

`@openreceive/react` and `@openreceive/elements` each ship a compiled
`styles.css`. Each sheet is self-contained, so a plain
`<link rel="stylesheet">` works with no build step. Each is also scoped: every
rule applies only inside what OpenReceive renders.

Serve the compiled `styles.css` without Tailwind processing. Import it from
JavaScript if your bundler handles CSS, or use a plain
`<link rel="stylesheet">`. Do not `@import` it into your app's Tailwind entry.
Its rules have zero specificity, so your page's styles can override checkout
styles. Scoping does not prevent that.
<!-- shared:end render -->

<!-- shared:begin render-notes -->
`<Checkout>` is complete as rendered. It already shows the `description` from
`amountFor` and the collapsed transaction-details panel. Do not build a custom
UI to show them. The display rules for them become your job only if you
replace the drop-in component ([Checkout UX](checkout-ux.md)).

Match the host page's theme. By default the checkout follows the payer's
stored choice, then the system color scheme. If this page always uses one
theme, lock it with `<Checkout theme="dark" … />`. On the custom element, set
the `theme` attribute. Locking the theme keeps a white card off a dark page.
CSS variables under `data-theme` style the checkout.
[Frontend checkout](frontend-checkout.md) lists the settings you can change.

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos, and the pay tutorials. There is no image file to copy
or serve, and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can wait to load tutorial screenshots until a tutorial first opens.
Single-file builds, including the standalone checkout, include them from the
start. If your Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](provider-registry.md#assets)).

That is the whole loop. Your server owns the price and the order. The payer
gets an invoice. `onPaid` runs inside the settlement transaction. If that
transaction rolls back, the callback may run again. For delivery to outside
systems, use an outbox in your app: record the message in the transaction and
send it after commit.
<!-- shared:end render-notes -->

Buy a Button is a runnable illustration of this boundary
([`examples/buttons/server/node-express`](../../examples/buttons/server/node-express)).
It is not a template to copy models from. It has products, visitors, and
orders, and the three hooks are the only bridge to OpenReceive. Map that shape
onto the models in THIS app.

<!-- shared:begin verify -->
## 6. Verify

```sh
npx openreceive doctor
```

`openreceive doctor` checks Node, `NWC_URI`, and the swap-provider
configuration. It also probes the wallet relay to confirm the code is
receive-only. Add `--db <file-or-url>` to confirm the migration ran. Add
`--url http://localhost:3000` to confirm the routes are mounted. Every failing
line states its own fix.
→ [openreceive doctor](api-reference.md#openreceive-doctor)

Then open the checkout in a browser. Confirm the payment-method icons and
wallet logos render. Open a wallet's pay tutorial to check its screenshots.
If an image is missing, look in the console for CSP violations and in the
Network panel for failed JavaScript chunks. To fix it, allow `data:` in
`img-src` and deploy the complete build output. Do not add image routes or
copy package source images. Do not use registry `icon_path` or tutorial
`path` keys as browser URLs.
<!-- shared:end verify -->

<!-- shared:begin next -->
## Next

- [Authorization](authorization.md) — your policy boundary
- [Payment storage](storage.md) — the table the library owns, and its state machine
- [Frontend Checkout](frontend-checkout.md) — what the browser side is responsible for
- [Automated Swaps](automated-swaps.md) — `swap_data`, and what turning swaps on commits you to
- [Swap refunds](swap-refunds.md) — the refund flow, and the per-order URL a payer needs to come back and claim a refund. Read it before you set `LSC_URI_PRIMARY`
- [Security](security.md) — which secrets must stay on the server

More on wiring, storage, and routes:
[Authorization](authorization.md), [Payment storage](storage.md),
[API reference](api-reference.md).
<!-- shared:end next -->
