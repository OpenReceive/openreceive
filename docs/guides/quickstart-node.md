# Node quickstart

OpenReceive supplies the payment service, mounted HTTP routes, and checkout UI.
Your application remains responsible for users, sessions, carts, prices, orders,
database transactions, and fulfillment.

The integration has one important rule: **create and price the host order before
starting OpenReceive checkout**. The browser sends only that order's ID.
OpenReceive asks your server to authorize the request and load the trusted order;
it never accepts a price from the browser.

```text
your order                       openreceive_payments
    └── amount / currency           ├── order_id
        authoritative price         ├── payment_hash
                                    ├── paid_at
                                    ├── expires_at
                                    └── swap_data (server-only)
```

## 1. Install the server packages

For an Express integration:

```sh
npm install @openreceive/node @openreceive/http @openreceive/express express
```

Install a frontend package only if you use it:

| Frontend | Package |
| --- | --- |
| React | `@openreceive/react` |
| Vue | `@openreceive/vue` |
| Svelte | `@openreceive/svelte` |
| Angular | `@openreceive/angular` |
| Web Components | `@openreceive/elements` |

Fastify and Next.js use the same host hooks described below; replace
`@openreceive/express` with `@openreceive/fastify` or `@openreceive/next`.

## 2. Add the payment-attempt model

Do not modify the host order table. Add one `openreceive_payments` model to the
database and ORM the application already owns:

```text
order_id      required, indexed; multiple rows per order
payment_hash  required string, unique
paid_at       nullable timestamp
expires_at    required timestamp
swap_data     nullable JSON/text, server-only
```

Each row is one invoice or swap attempt. An order may accumulate expired unpaid
rows before one attempt settles. `paid_at` transitions from null only once per
attempt; host fulfillment runs only for the first settled attempt on the order.

Do not return `swap_data` from your application API. It may contain a provider
credential. OpenReceive passes it only between server-side hooks and never puts
it in a mounted HTTP response.

Copy-ready schemas and transaction patterns for Prisma, Drizzle, TypeORM,
Sequelize, and Knex are in [Node ORM Recipes](node-orms.md).

## 3. Separate credentials from ordinary configuration

OpenReceive has three secret environment variables:

```dotenv
NWC_URI=nostr+walletconnect://...
LSC_URI_PRIMARY=
LSC_URI_BACKUP=
```

`NWC_URI` is required and must be a receive-only Nostr Wallet Connect
connection. The two LSC variables are optional swap-provider connections.
Leave both empty if the application accepts direct Lightning only.

Copy [`.env.example`](../../.env.example) to `.env` for local development. The
OpenReceive library deliberately does not search for `.env`; the application
entry point owns environment loading. With Node 22:

```ts
// First lines of the local-development server entry point.
try {
  process.loadEnvFile();
} catch (error) {
  // A production deployment may inject variables without a .env file.
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}
```

Never put `NWC_URI` or an LSC URI in browser code, a public-prefixed variable,
logs, screenshots, committed fixtures, or a tracked configuration module.
Production should inject them with its normal secret manager.

To enable automated swaps, store a complete
[Lightning Swap Connect URI](lightning-swap-connect.md) in the primary LSC
variable:

```dotenv
LSC_URI_PRIMARY=lightning+swapconnect://swap.example/?key=...&secret=...
```

LSC is optional. When configured and quoted by the provider, it lets customers
start with the swap assets listed in
[What can customers pay with?](../../README.md#what-can-customers-pay-with)
while the merchant still receives Bitcoin over Lightning.

Keep non-secret settings in an ordinary tracked Node module:

```ts
// config/openreceive.ts
import type { CreateOpenReceiveOptions } from "@openreceive/node";

export const openReceiveConfig = {
  priceCurrencies: ["USD"],
  logging: {
    enabled: true,
    directory: "./logs",
    filename: "openreceive.log",
    maxFileSizeMb: 10,
    maxFiles: 5,
    level: "debug",
  },
} satisfies Pick<CreateOpenReceiveOptions, "priceCurrencies" | "logging">;
```

`priceCurrencies` controls which fiat currencies the host may use to price
orders; fiat is not a payment or settlement asset. Direct BTC and sats pricing
also works. The full built-in fiat list is maintained in
[What can customers pay with?](../../README.md#what-can-customers-pay-with).

## 4. Create the host order first

Your application needs an ordinary order-creation route. Validate the cart
against your catalog, calculate the total with exact decimal money math, and
persist the result before returning an ID.

```ts
app.post("/orders", async (request, response, next) => {
  try {
    // These are application functions, not OpenReceive functions.
    const viewer = await requireCurrentUser(request);
    const cart = await validateCartAgainstCatalog(request.body);
    const order = await orders.create({
      userId: viewer.id,
      currency: "USD",
      total: cart.totalUsd, // Store an exact decimal value, never a binary float.
    });

    response.status(201).json({ order_id: order.id });
  } catch (error) {
    next(error);
  }
});
```

This route is the price authority. The later OpenReceive request contains
`order_id`, not `amount`, `sats`, or `amount_msats`.

## 5. Create the OpenReceive service

`onPaid` receives wallet-verified settlement. Look up the payment attempt by
hash, set its `paid_at` only when null, lock the related order, and perform
fulfillment only when no sibling attempt was already paid.

```ts
import { createOpenReceive } from "@openreceive/node";
import { openReceiveConfig } from "./config/openreceive.ts";

const service = await createOpenReceive({
  ...openReceiveConfig,
  onPaid: async ({ paymentHash, paidAt }) => {
    await payments.markPaidOnce({
      paymentHash,
      paidAt,
    });
  },
});
```

`onPaid` may be delivered more than once. `markPaidOnce` therefore must be
idempotent. A wallet notification is only a hint to refresh state; final
settlement requires `settled_at` or a wallet transaction state of `settled`.

## 6. Define the three host hooks

Mounted browser routes require three application callbacks:

| Hook | Your application answers |
| --- | --- |
| `authorize` | May this request act on this order? |
| `resolveCheckout` | What is the order amount and which payment attempt was selected? |
| `onCheckoutCreated` | Did the host atomically commit this new payment attempt? |

Defining them as named functions keeps the middleware configuration small and
makes each security boundary easier to test.

### `authorize`: use your normal session and ownership policy

OpenReceive deliberately does not inspect your session. It passes the
Web-standard `Request`, requested action, and order ID to your application.

```ts
import type { OpenReceiveAuthorize } from "@openreceive/http";

const authorizeOpenReceive: OpenReceiveAuthorize = async ({
  action,
  request,
  resource,
}) => {
  const orderId = resource.order_id;
  if (!orderId) return false;

  // Replace this with the session/authentication system your app already uses.
  const viewer = await sessions.currentUser(request);
  if (!viewer) return false;

  // `action` distinguishes checkout creation, payment checks, swap reads,
  // and refunds, so your policy can be stricter for sensitive operations.
  return orders.userMayPerform({
    userId: viewer.id,
    orderId,
    action,
  });
};
```

Knowing an order ID is not authentication. Anonymous checkout applications can
use their own signed guest cookie or another host-owned access mechanism.

### Build both persistence hooks

The shared helper selects the exact historical attempt requested by status or
refund calls, reuses one live attempt on create, and allows a new row after all
older attempts expire:

```ts
import { createOpenReceivePaymentHooks } from "@openreceive/http";

const paymentHooks = createOpenReceivePaymentHooks({
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => ({
    currency: order.currency,
    value: order.total.toString(),
  }),
  payments: paymentRepository,
});

const resolveOpenReceiveCheckout = paymentHooks.resolveCheckout;
const commitOpenReceiveCheckout = paymentHooks.onCheckoutCreated;
```

`paymentRepository` implements `listForOrder(orderId)` and
`commitAttempt(input)`. The commit transaction locks the existing order row,
rejects another paid or live attempt, and inserts the new payment row. If it
throws, OpenReceive returns `409` and withholds the new payer instructions.
See [Node ORM Recipes](node-orms.md) for complete schemas and lock queries.

Payment checks, swap status, and refunds carry `order_id` plus the displayed
`payment_hash`. The helper verifies that the selected attempt belongs to that
order before returning server-only `swapData`.

## 7. Mount the Express routes

With the three hooks named, the actual middleware setup is short:

```ts
import express from "express";
import { openReceiveExpress } from "@openreceive/express";

const app = express();
app.use(express.json());

app.use(openReceiveExpress({
  service,
  authorize: authorizeOpenReceive,
  resolveCheckout: resolveOpenReceiveCheckout,
  onCheckoutCreated: commitOpenReceiveCheckout,
}));
```

The default prefix is `/openreceive`. The middleware adds:

| Route | Purpose |
| --- | --- |
| `POST /openreceive/checkouts` | Create or recover the order's Lightning checkout |
| `POST /openreceive/payments/check` | Refresh wallet settlement for the order |
| `POST /openreceive/swaps/quote` | Quote a host-priced swap |
| `POST /openreceive/swaps` | Create or recover a swap |
| `POST /openreceive/swaps/status` | Refresh provider state |
| `POST /openreceive/swaps/refunds` | Request an eligible refund |
| `GET /openreceive/rates` | Read configured BTC/fiat rates |

You do not need to recreate these routes in your application.

## 8. Render the frontend checkout

The frontend first calls your `/orders` route. It then renders the checkout with
the returned ID:

```ts
const response = await fetch("/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cart }),
});

if (!response.ok) {
  throw new Error("Could not create order.");
}

const { order_id } = await response.json();
```

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout
  orderId={order_id}
  prefix="/openreceive"
/>
```

`<Checkout>` sends only `order_id` when creating. Status/refund requests also
carry the displayed `payment_hash` so the host can select that exact attempt.
It never receives the NWC connection, provider credentials, or `swap_data`, and
it never selects the amount charged.

Fetch order summaries and build resume pages through your own application API.
OpenReceive does not own order display data or host routing.

## 9. Understand the complete request flow

```text
browser
  POST /orders { cart }
      │
      ▼
host validates cart, calculates exact price, creates order row
      │
      └── response { order_id }

browser renders <Checkout orderId={order_id} />
      │
      ▼
POST /openreceive/checkouts { order_id }
      │
      ├── authorize(request, action, order_id)
      ├── resolveCheckout(order_id) → amount + live payment attempt, if any
      ├── create or recover wallet invoice
      ├── onCheckoutCreated(...) → atomic host database commit
      └── response exposes payer instructions only after commit succeeds

later status refresh
      │
      ├── authorize again
      ├── host verifies { order_id, payment_hash } selects its payment row
      ├── OpenReceive verifies the receive wallet
      └── settled payment → onPaid({ paymentHash, paidAt })
```

## 10. Retries, concurrency, and expired invoices

- If the order has no live payment row, OpenReceive creates an attempt and asks
  the host to commit it.
- If the order already has one live attempt, retries recover that checkout.
- If concurrent requests create different invoices, only the transaction that
  first locks the host order and inserts its row may expose its invoice. The
  losing request receives `409`.
- Status polling never creates a new invoice.
- When all unpaid attempts are expired or terminal, a create request may append
  another row for the same order.
- Keep historical hashes: a late settlement always updates the exact attempt
  originally exposed.

## 11. Direct server-side checkout

For a server-rendered flow that does not use mounted browser routes, call the
service directly:

```ts
const checkout = await service.createCheckout({
  orderId: order.id,
  amount: {
    currency: order.currency,
    value: order.total.toString(),
  },
});

await payments.commitAttempt({
  orderId: order.id,
  paymentHash: checkout.paymentHash,
  checkout,
});

return checkout;
```

The same commit-before-display rule applies. For retry recovery, call
`recoverCheckout({ orderId, paymentHash })` with the selected live attempt.

## 12. Verify the setup

Run:

```sh
npx openreceive doctor
```

The command checks server configuration and required receive-wallet
capabilities. Node applications run their normal ORM migration command; the
OpenReceive runtime still receives no database URL.

## What to read next

- [Authorization](authorization.md) explains the host policy boundary.
- [Frontend Checkout](frontend-checkout.md) covers browser responsibilities.
- [Automated Swaps](automated-swaps.md) covers `swap_data`, provider state, and
  refund safety.
- [Node ORM Recipes](node-orms.md) provides ready-to-adapt schemas.
- [Storage](storage.md) describes the host-owned payment table.
- [Security](security.md) lists the server-only secret boundaries.
