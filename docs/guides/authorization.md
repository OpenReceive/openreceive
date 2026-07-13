# Authorization

Mount OpenReceive's routes and keep auth in your app. OpenReceive never inspects
your session, cookie, JWT, or header — it calls the `authorize` hook you provide
and obeys the return value.

You almost never need to know the path table. Price orders with
`prepareCheckout`, fulfill with `onPaid`, and render `<Checkout orderId />`.
Capability tokens are minted and attached for you.

## Recommended: mount + a preset

```ts
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
import { guestCheckout, withUser } from "@openreceive/http";

const service = await createOpenReceive({ onPaid });

// Guest checkout (no accounts): anonymous create; reads gated for you.
app.use(openReceiveExpress({
  service,
  prepareCheckout,
  authorize: guestCheckout(),
  // optional admin sweep:
  // authorize: guestCheckout({ allowSweep: (ctx) => isAdmin(ctx.request) }),
}));

// Or a logged-in app: your session owns the order.
app.use(openReceiveExpress({
  service,
  prepareCheckout,
  authorize: withUser((request) => currentUserFromMySession(request), {
    ownsOrder: (user, ctx) => orderBelongsTo(user, ctx.resource.order_id),
    isAdmin: (user) => user.admin,
  }),
}));
```

With no `authorize` at all, the default is already safe for guest checkout:
anonymous create is allowed, order reads require the per-order token the
checkout component carries, and admin sweep is denied.

`guestCheckout()` authorizes polls and swap/refund actions for whoever holds the
per-order capability token. For guest resume after refresh, pass `resume` on
`<Checkout orderId />` — see [Frontend Checkout](frontend-checkout.md).

### Rails

Engine controllers inherit your `ApplicationController`, so CSRF,
`authenticate_user!`, and `current_user` come along for free. Configure the
hooks in the initializer:

```ruby
OpenReceive.configure do |config|
  config.parent_controller = "ApplicationController"
  config.prepare_checkout = prepare_checkout
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

## What you configure

| Hook | Required? | Job |
| --- | --- | --- |
| `prepareCheckout` / `prepare_checkout` | **Yes** | Sole price authority on POST `/prepare`. Return `{ amount, orderId?, summary?, metadata? }` or `null` → 404. Client `amount`/`sats`/`usd` on the create body are rejected. |
| `authorize` | No (safe default) | Allow/deny by action. Use a preset unless you have a custom policy. |
| `onPaid` | Recommended | Idempotent fulfillment after backend-verified settlement. |
| `rateLimit` | Optional | Extra protection on anonymous create. |

Tip-jar / buyer-chosen amounts still go **through** `prepareCheckout` (read
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

## Custom controllers

Prefer the mounted router. If you must call service methods from your own
controllers, see
[Custom Controller Integration](../internal/custom-controller-integration.md).
