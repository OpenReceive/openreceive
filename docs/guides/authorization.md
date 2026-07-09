# Authorization

Mount OpenReceive's routes and keep auth in your app. OpenReceive never inspects
your session, cookie, JWT, or header — it calls the `authorize` hook you provide
and obeys the return value.

You almost never need to know the path table. Price orders with
`getCheckoutAmount`, fulfill with `onPaid`, and render `<Checkout orderId />`.
Capability tokens are minted and attached for you.

## Recommended: mount + a preset

```ts
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
import { guestCheckout, withUser } from "@openreceive/http";

const service = await createOpenReceive({ onPaid });

// Guest checkout (no accounts): anonymous create; reads gated for you.
app.use(openReceiveExpress({
  service,
  getCheckoutAmount,
  authorize: guestCheckout(),
  // optional admin sweep:
  // authorize: guestCheckout({ allowSweep: (ctx) => isAdmin(ctx.request) }),
}));

// Or a logged-in app: your session owns the order.
app.use(openReceiveExpress({
  service,
  getCheckoutAmount,
  authorize: withUser((request) => currentUserFromMySession(request), {
    ownsOrder: (user, ctx) => orderBelongsTo(user, ctx.resource.order_id),
    isAdmin: (user) => user.admin,
  }),
}));
```

With no `authorize` at all, the default is already safe for guest checkout:
anonymous create is allowed, order reads require the per-order token the
checkout component carries, and admin sweep is denied.

### Rails

Engine controllers inherit your `ApplicationController`, so CSRF,
`authenticate_user!`, and `current_user` come along for free. Configure the
hooks in the initializer:

```ruby
OpenReceive.configure do |config|
  config.parent_controller = "ApplicationController"
  config.get_checkout_amount = get_checkout_amount
  config.authorize = OpenReceive::Server::Presets.guest_checkout
  # or: OpenReceive::Server::Presets.with_user(...)
end
```

```ruby
# config/routes.rb — the generator adds this
mount OpenReceive::Engine => "/openreceive"
```

Prefer a controller concern? Include `OpenReceive::Authorization` and implement
`openreceive_authorize(context)` so you can use Pundit/CanCanCan/`current_user`
directly.

## What you configure (not the path table)

| Hook | Required? | Job |
| --- | --- | --- |
| `getCheckoutAmount` / `get_checkout_amount` | **Yes** | Sole price authority on create. Return `{ amount: … }` or `null` → 404. Client `amount`/`sats`/`usd` on the create body are rejected. |
| `authorize` | No (safe default) | Allow/deny by action. Use a preset unless you have a custom policy. |
| `onPaid` | Recommended | Idempotent fulfillment after backend-verified settlement. |
| `rateLimit` | Optional | Extra protection on anonymous create. |

Tip-jar / payer-chosen amounts still go **through** `getCheckoutAmount` (read
`metadata` or your session, validate, return). That keeps "trust the client" an
explicit host decision.

## CORS and CSRF

Same-origin mounts of `/openreceive` rely on an httpOnly order-token cookie for
browser polls. Keep your normal CSRF protection on cookie-authenticated POSTs
your app owns. Do not combine wildcard CORS with credentials.

```ts
app.use(cors({
  origin: "https://shop.example",
  credentials: true
}));
```

## Settlement

Frontend `onSettled` callbacks are display hints only. Fulfillment belongs in
the server-side settlement hook:

```ts
const service = await createOpenReceive({
  onPaid: async ({ orderId, checkoutId }) => {
    await markOrderPaidInYourApp({ orderId, checkoutId });
  },
});
```

When an order is paid, fulfill against the paid checkout snapshot — it is the
checkout the customer actually paid.

## Advanced: call service methods from your own controllers

Prefer the mounted router. Use this path only when you create a checkout
server-side and pass the snapshot into `<Checkout checkout={…} />`. Amounts you
pass to `getOrCreateCheckout` are trusted because they come from your server,
not from a public create body. You must authorize status/swap reads the same
way you authorize any other private order route.

### Express

```ts
import express from "express";
import { createOpenReceive, OpenReceiveServiceError } from "@openreceive/node";

const checkoutRoutes = express.Router();
checkoutRoutes.use(express.json());

const openreceive = await createOpenReceive({
  onPaid: async ({ orderId }) => {
    await markOrderPaidInYourApp(orderId);
  }
});

// Your app's order route — not OpenReceive's create-checkout HTTP body.
checkoutRoutes.post("/create_order", async (req, res, next) => {
  try {
    const order = await createOrderFromCart(req.user, req.body.cart);
    const checkout = await openreceive.getOrCreateCheckout({
      orderId: order.uuid,
      amount: { currency: "USD", value: order.total_amount.value },
      memo: `Order ${order.number}`
    });
    res.status(201).json({ order, checkout });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      res.status(error.status).json(error.body);
      return;
    }
    next(error);
  }
});

checkoutRoutes.post("/order", async (req, res, next) => {
  try {
    // Authorize the caller for req.body.order_id here (session or ownership
    // check) before calling the service. order_id is an identifier, not a capability.
    const orderId = req.body.order_id;
    const action = req.body.action ?? "status";
    if (action === "status") {
      const order = await openreceive.getOrder({ orderId });
      const swap = await openreceive.swapOptions({ orderId });
      res.json({
        ...order,
        swapsEnabled: swap.enabled,
        swapPayOptions: swap.enabled ? swap.options : [],
      });
      return;
    }
    if (action === "swap_quote") {
      res.json({
        quote: await openreceive.swapQuote({
          orderId,
          payInAsset: req.body.pay_in_asset,
        }),
      });
      return;
    }
    if (action === "start_swap") {
      res.json({
        attempt: await openreceive.startSwap({
          orderId,
          payInAsset: req.body.pay_in_asset,
        }),
      });
      return;
    }
    if (action === "refund_swap") {
      res.json({
        attempt: await openreceive.refundSwap({
          attemptId: req.body.attempt_id,
          refundAddress: req.body.refund_address,
          refundNonce: req.body.refund_nonce,
          confirm: req.body.confirm === true,
        }),
      });
      return;
    }
    res.status(400).json({
      code: "INVALID_REQUEST",
      message: 'Unknown order action. Expected "status", "swap_quote", "start_swap", or "refund_swap".',
    });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      res.status(error.status).json(error.body);
      return;
    }
    next(error);
  }
});
```

### Next.js

```ts
// app/create_order/route.ts
import { createOpenReceive, OpenReceiveServiceError } from "@openreceive/node";

export const runtime = "nodejs";

const openreceiveReady = createOpenReceive({
  onPaid: async ({ orderId }) => {
    await markOrderPaidInYourApp(orderId);
  }
});

export async function POST(request: Request) {
  const openreceive = await openreceiveReady;

  try {
    const body = await request.json();
    const order = await createOrderFromCart(body.cart);
    const checkout = await openreceive.getOrCreateCheckout({
      orderId: order.uuid,
      amount: { currency: "USD", value: order.total_amount.value },
      memo: `Order ${order.number}`
    });
    return Response.json({ order, checkout }, { status: 201 });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      return Response.json(error.body, { status: error.status });
    }
    throw error;
  }
}
```

For App Router mounts of the shipped routes, use
`openReceiveNextHandlers({ service, getCheckoutAmount })` under
`app/openreceive/[...openreceive]/route.ts` — see the
[Node Quickstart](quickstart-node.md).
