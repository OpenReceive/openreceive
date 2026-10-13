# NestJS quickstart

NestJS on its default Express platform. Requires Node ≥ 22 and NestJS ≥ 10.

OpenReceive mounts in `main.ts` as Express middleware, with
`@openreceive/express`, the adapter the [Express quickstart](quickstart-node.md)
uses. There is no Nest module to import. Three things differ from a plain
Express app, and this page is about them:

- Nest adds its JSON body parser only when the app starts listening, after
  anything `main.ts` mounts. Add it before the mount with
  `app.useBodyParser("json")`.
- The hooks reach the app's own services through `app.get()`: the order
  service, and the TypeORM `DataSource` or the Prisma service.
- Guards, interceptors and pipes run for controllers, not for middleware. So
  `authorize` makes the same check your guard makes.

## 1. Install

```sh
npm install @openreceive/express @openreceive/http @openreceive/react
```

`@openreceive/express` mounts the routes. `@openreceive/http` supplies the
database handle in step 4 (`typeOrmDb`, `prismaDb`). Swap `@openreceive/react`
for the UI package your frontend uses: `@openreceive/vue`,
`@openreceive/svelte`, `@openreceive/angular`, or `@openreceive/elements` for
server-rendered views. The `openreceive` package is only the CLI, and
`npx openreceive …` below needs no install.

This page is for Nest's default Express platform. OpenReceive has not been
tested on `@nestjs/platform-fastify`.

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
`paymentsSchemaSql(dialect)` from `@openreceive/http`. Your adapter already
pulls that package in, but this import is yours, so install it too:
`npm install @openreceive/http`.
<!-- shared:end migrate -->

With TypeORM, the scaffold writes
`src/migrations/20260101000000-create-openreceive-tables.ts`. Register it the
way the app registers its other migrations: a `migrations` glob such as
`dist/migrations/*.js` already picks it up. It runs at start with
`migrationsRun: true`, or with `npx typeorm migration:run -d <data source>`.
With Prisma, scaffold with `--orm prisma` and run `npx prisma migrate dev`.

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
its own. If `AppModule` already imports `ConfigModule.forRoot()` from
`@nestjs/config`, that loads `.env` into `process.env` before `main.ts` mounts
OpenReceive. Otherwise put `import "dotenv/config";` first in `main.ts`
(`npm install dotenv`). [Environment variables](environment-variables.md)
covers production secrets.

## 4. Wire OpenReceive in main.ts

One factory call takes your hooks and a database handle. Mount it in
`main.ts`, after the app's own session, cookie or Passport middleware and
before `app.listen()`. There is no background reconciler: settlement runs
during normal requests, through the durable reconcile gate.

```ts
import "dotenv/config"; // drop this line if ConfigModule.forRoot() loads .env
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { openReceiveExpress } from "@openreceive/express";
import { typeOrmDb } from "@openreceive/http";
import type { Request } from "express";
import { DataSource } from "typeorm";
import { AppModule } from "./app.module";
import { AuthService } from "./auth/auth.service"; // your existing services
import { OrdersService } from "./orders/orders.service";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // The app's own app.use(session(...)), cookie-parser or passport.session()
  // stay above the mount, so the session is on the request when authorize runs.
  const orders = app.get(OrdersService);
  const auth = app.get(AuthService);
  // Nest adds its JSON body parser only at listen, after this mount. Without
  // this line every checkout request fails with a 500.
  app.useBodyParser("json");
  app.use(
    openReceiveExpress({
      wallet: { nwc: process.env.NWC_URI! }, // receive-only NWC code; your app refuses to start otherwise
      storage: {
        // The app's TypeORM DataSource. Prisma: prismaDb(app.get(PrismaService), "postgres").
        db: typeOrmDb(app.get(DataSource), "postgres"),
        onPaid: async ({ reference, paidAt, query }) => {
          // Settlement transaction; runs only for the first settled attempt for
          // a reference. The WHERE clause is the lock: a second fulfillment
          // path of yours (admin action, replayed job) updates zero rows. Use
          // `query` here, not a repository: it runs in this same transaction.
          // `$1` on postgres, `?` on sqlite.
          await query(
            "UPDATE orders SET status = 'paid', paid_at = $1 WHERE id = $2 AND status = 'awaiting_payment'",
            [paidAt, reference],
          );
        },
      },
      // The price for a reference (your order id, as a string) from your own
      // data. `value` is a decimal STRING from the order row, never a float and
      // never a request param. `description` is what the payer is buying.
      amountFor: async (reference) => {
        const order = await orders.findOne(reference);
        return order
          ? {
              currency: "USD",
              value: order.total.toString(),
              description: `${order.lines.length} items`,
            }
          : null;
      },
      // Nest's guards do not run here: make the check your guard makes.
      // `native` is the Express request your session, cookie-parser or
      // Passport middleware already filled in. `request` is a Web Request
      // without any of that, so a helper given it finds no session and every
      // payer gets a 403. `resource.reference` is a claim from the payer's
      // browser, not proof.
      authorize: async ({ action, native, resource }) =>
        orders.viewerMay(await auth.currentUser(native as Request), resource.reference, action),
      // Recommended for public web shops: caps invoice creation at 60 per
      // client IP per hour. Leave it off for point-of-sale deployments, where
      // many payers share the terminal's IP.
      rateLimiting: true,
    }),
  );
  // Behind a reverse proxy, rate limiting needs the real client IP. Delete the
  // line only if the app faces the network directly (see the rate-limiting guide).
  app.set("trust proxy", 1);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

The first request checks the wallet. Later OpenReceive requests also settle
pending invoices, so a payer who closes the tab is still covered.
→ [openReceiveExpress](api-reference.md#openreceiveexpress) ·
[authorize context](api-reference.md#the-authorize-context)

Where `authorize` finds the user:

- **A session** (express-session, or Passport with `passport.session()`):
  `native.session` and `native.user` are there, because their middleware runs
  before the mount.
- **A JWT in a cookie**: verify it the way your guard does, for example with
  `app.get(JwtService).verifyAsync(token)` on the cookie's value.
  `@nestjs/passport`'s `AuthGuard` never runs here, so `native.user` is empty.
- **A bearer token only in browser storage**: the drop-in checkout sends the
  browser's cookies with its requests, not an `Authorization` header. Set an
  httpOnly cookie when the order is created, and check that cookie against
  the order in `authorize`.

`app.setGlobalPrefix()` does not move middleware. The routes stay under
`/openreceive`, the `prefix` the checkout below uses.

An optional worker, `startNotificationWorker({ service, host })`, listens for
wallet payment notifications so settlement does not wait for the next page
load. → [startNotificationWorker](api-reference.md#startnotificationworker)

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
Its rules have low specificity, so your page's styles can override checkout
styles. Scoping does not prevent that.
<!-- shared:end render -->

Server-rendered views (Handlebars, EJS, Pug) use the `<openreceive-checkout>`
element from `@openreceive/elements` instead. Serve its standalone script and
stylesheet straight from the package, so there is nothing to build:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

app.useStaticAssets(
  path.dirname(
    fileURLToPath(import.meta.resolve("@openreceive/elements/standalone/openreceive-checkout.js")),
  ),
  { prefix: "/checkout-assets/" },
);
```

In a CommonJS build, the default before Nest 12, use
`path.dirname(require.resolve("@openreceive/elements/standalone/openreceive-checkout.js"))`.
Then, on the order's page:

```html
<link rel="stylesheet" href="/checkout-assets/openreceive-checkout.css">
<script type="module" src="/checkout-assets/openreceive-checkout.js"></script>
<openreceive-checkout reference="{{order.id}}" prefix="/openreceive"></openreceive-checkout>
```

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

The NestJS starter is a runnable one-product shop with all of the above:
TypeORM, sessions, Handlebars views and the element
([`examples/nestjs-starter`](../../examples/nestjs-starter)). Map its hooks
onto the models in THIS app; do not copy its order model over yours.

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
