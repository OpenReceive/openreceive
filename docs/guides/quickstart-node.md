# Node quickstart

OpenReceive supplies the payment service, mounted HTTP routes, and checkout UI.
Your application remains responsible for users, sessions, carts, prices, orders,
database transactions, and fulfillment.

The integration has one important rule: **create and price the host order before
starting OpenReceive checkout**. The browser sends only that order's ID.
OpenReceive asks your server to authorize the request and load the trusted order
row; it never accepts a price from the browser.

```text
your order row
    ├── amount / currency     authoritative price
    ├── payment_hash         Lightning invoice identity
    ├── paid_at              write-once settlement marker
    └── swap_data            optional, server-only provider recovery data
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

## 2. Add payment fields to your existing order model

OpenReceive does not create a database or migration. Add these fields to the
order model your application already owns:

```text
payment_hash  nullable string, unique
paid_at       nullable timestamp
swap_data     nullable JSON/text, server-only
```

`payment_hash` identifies the invoice in your receive wallet and is also the
checkout-creation idempotency guard. `paid_at` must transition from null only
once. `swap_data` is needed only when automated swaps are enabled.

Do not return `swap_data` from your application API. It may contain a provider
credential. OpenReceive passes it only between server-side hooks and never puts
it in a mounted HTTP response.

## 3. Configure the receive wallet

Create `openreceive.yml` in the root of the application:

```yaml
nwc: nostr+walletconnect://...
```

The NWC connection must be receive-only and server-only. Never place it in
browser code, a public environment variable, logs, screenshots, or committed
fixtures.

`createOpenReceive()` reads this file automatically. You normally do not pass an
`nwc` option in application code. That option exists for an intentional runtime
override, such as an isolated test.

To accept supported swap assets such as USDT, USDC, SOL, and ETH while still
settling into Bitcoin, add a provider:

```yaml
nwc: nostr+walletconnect://...

swap:
  providers:
    - id: primary
      protocol: fixedfloat
      base_url: https://ff.io
      key: ...
      secret: ...
```

Swap configuration is optional. See
[`openreceive.yml.example`](../../openreceive.yml.example) for the other
settings and [Automated Swaps](automated-swaps.md) for the provider lifecycle.

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
      paymentHash: null,
      paidAt: null,
      swapData: null,
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

`onPaid` receives wallet-verified settlement. Look up the host order by payment
hash, set `paid_at` only when it is still null, and perform fulfillment in the
same replay-safe application transaction.

```ts
import { createOpenReceive } from "@openreceive/node";

const service = await createOpenReceive({
  onPaid: async ({ paymentHash, paidAt }) => {
    await orders.markPaidOnce({
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
| `resolveCheckout` | What amount and existing payment state are stored on the order? |
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

### `resolveCheckout`: load trusted state from the order row

This hook runs after authorization. It receives the untrusted order ID from the
request, looks up the host row, and returns only server-owned values.

The explicit branches below are intentional. They show the three possible
database states without hiding the behavior inside conditional object spreads.

```ts
import {
  hostError,
  type ResolveCheckoutHook,
} from "@openreceive/http";

const resolveOpenReceiveCheckout: ResolveCheckoutHook = async ({ orderId }) => {
  const order = await orders.find(orderId);

  if (!order) {
    throw hostError("Order not found.", 404, "NOT_FOUND");
  }

  // Always derive the amount from the trusted database row.
  const amount = {
    currency: order.currency,
    value: order.total.toString(),
  };

  // State 1: no checkout has been committed yet.
  // OpenReceive may create an invoice, then call onCheckoutCreated.
  if (!order.paymentHash) {
    return { amount };
  }

  // State 2: a Lightning checkout already exists.
  // Returning paymentHash makes a retry recover that checkout instead of
  // silently minting another invoice.
  if (!order.swapData) {
    return {
      amount,
      paymentHash: order.paymentHash,
    };
  }

  // State 3: this is a swap-backed checkout.
  // swapData remains server-only and lets OpenReceive refresh provider state.
  return {
    amount,
    paymentHash: order.paymentHash,
    swapData: order.swapData,
  };
};
```

The resolver is also called for payment checks, swap status, and refunds. Those
browser requests still contain only `order_id`; the host loads `paymentHash`
and `swapData` after authorization.

### `onCheckoutCreated`: commit before payer instructions escape

OpenReceive calls this hook after creating an invoice or provider order but
before returning the invoice or swap deposit address to the payer.

```ts
import type { CheckoutCreatedHook } from "@openreceive/http";

const commitOpenReceiveCheckout: CheckoutCreatedHook = async ({
  orderId,
  paymentHash,
  swapData,
}) => {
  await orders.commitPaymentAttempt({
    orderId,
    paymentHash,
    swapData,
  });
};
```

`commitPaymentAttempt` must use a row lock or compare-and-set transaction:

1. If `payment_hash` is null, store the new hash and optional `swap_data`.
2. If the same hash is already stored, treat the operation as an idempotent
   retry.
3. If a different hash won a concurrent request, throw and let the caller
   retry from the winning row.
4. Never overwrite a committed payment hash with a different one.

If this hook throws, OpenReceive returns `409` and withholds the new payer
instructions. That prevents an invoice unknown to the host database from being
shown.

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

`<Checkout>` sends only `order_id` to the mounted routes. It never receives the
NWC connection, provider credentials, or `swap_data`, and it never selects the
amount charged.

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
      ├── resolveCheckout(order_id) → amount / paymentHash / swapData
      ├── create or recover wallet invoice
      ├── onCheckoutCreated(...) → atomic host database commit
      └── response exposes payer instructions only after commit succeeds

later status refresh
      │
      ├── authorize again
      ├── host reloads payment_hash
      ├── OpenReceive verifies the receive wallet
      └── settled payment → onPaid({ paymentHash, paidAt })
```

## 10. Retries, concurrency, and expired invoices

- If the order has no `payment_hash`, OpenReceive creates a payment attempt and
  asks the host to commit it.
- If the order already has a live `payment_hash`, returning it from
  `resolveCheckout` makes retries recover the same checkout.
- If concurrent requests create different invoices, only the transaction that
  wins the host row may expose its invoice. The losing request receives `409`.
- Status polling never creates a new invoice.
- If the stored invoice can no longer be recovered as a live pending checkout,
  the mounted create route returns `409`. Your application decides whether to
  create a new order/payment attempt; OpenReceive does not silently replace the
  host's committed hash.
- A late settlement still belongs to the payment hash originally stored on the
  order, so never discard old hashes without an application-level recovery
  policy.

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

await orders.commitPaymentAttempt({
  orderId: order.id,
  paymentHash: checkout.paymentHash,
});

return checkout;
```

The same commit-before-display rule applies. For retry recovery, call
`recoverCheckout({ orderId, paymentHash })` with the hash stored on the order.

## 12. Verify the setup

Run:

```sh
npx openreceive doctor
```

The command checks the storage-free configuration and required receive-wallet
capabilities. There is no OpenReceive migration command, token-key generator,
or signing-key configuration.

## What to read next

- [Authorization](authorization.md) explains the host policy boundary.
- [Frontend Checkout](frontend-checkout.md) covers browser responsibilities.
- [Automated Swaps](automated-swaps.md) covers `swap_data`, provider state, and
  refund safety.
- [Storage](storage.md) describes the minimal host-order fields.
- [Security](security.md) lists the server-only secret boundaries.
