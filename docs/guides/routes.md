# Shipped Routes

OpenReceive ships the HTTP routes so you do not hand-write controllers. You mount them
under a prefix you choose (default `/openreceive`) and keep 100% of authentication in your
app. OpenReceive never inspects your session, cookie, JWT, or header — it calls the hooks
you provide (`authorize`, `getCheckoutAmount`, `rateLimit`) and obeys their return values. This
is inversion of control: the host hooks into OpenReceive, not the reverse.

The canonical contract is `spec/openapi/openreceive-http.v1.yaml`. Every Node adapter and the
Rails engine implement it identically and are held byte-equal by HTTP golden vectors.

## The route contract

| Method + path | Tier | action | Body / response |
| --- | --- | --- | --- |
| `POST {prefix}/checkouts` | 1 | `checkout.create` | `{ order_id, memo?, description_hash?, metadata? }` → `201 { checkout, order_access_token? }` (price from `getCheckoutAmount` only; client `amount`/`sats`/`usd` → 400) |
| `POST {prefix}/orders/{order_id}` | 2 | `order.read` / `swap.*` | `{ order_id, action? }` → `200` OrderStatus / `{quote}` / `{attempt}` |
| `GET {prefix}/checkouts/{checkout_id}` | 2 | `checkout.read` | → `200` Checkout |
| `GET {prefix}/orders/{order_id}/swap-options` | 2 | `swap.options` | → `200 { enabled, options[] }` |
| `GET {prefix}/rates` | 1 | (public) | `?base=&currencies=` → `200` rate quotes |
| `POST {prefix}/admin/sweep` | 3 | `invoice.sweep` | → `200` reconcile summary (fails closed) |

Wire style matches the existing browser packages: `POST` + JSON, snake_case bodies, an
action multiplexer on the order route. Unknown `action` returns `400` — never silently
treated as `status`.

Error bodies are `{ code, message, retryable?, request_id?, details? }` with `code` from the
enum in `spec/schemas/error.schema.json`. Status mapping: `INVALID_REQUEST`→400,
`UNAUTHORIZED`→403, `NOT_FOUND`→404, `CONFLICT`→409, `RATE_LIMITED`→429,
`WALLET_UNAVAILABLE`→503, `INTERNAL`→500.

## Three security tiers

- **Tier 1 — anonymous-capable** (`checkout.create`, `rates`): open by default; protected by
  your `rateLimit` hook, your `authorize` hook, and your `getCheckoutAmount` hook so the price
  cannot be forged.
- **Tier 2 — capability-token scoped** (order/checkout reads, swap actions on your own order):
  requires a valid per-order capability token **or** an allow decision from `authorize`.
- **Tier 3 — privileged** (`invoice.sweep`): requires `authorize` to allow, and **fails
  closed** — with no `authorize` policy configured, Tier-3 routes return `403` and log a loud
  configuration error at mount time.

### The `authorize` hook

```ts
authorize(context) -> boolean            // true = allow, false = deny (403 UNAUTHORIZED)
context = {
  action,     // "checkout.create" | "order.read" | "checkout.read" |
              // "swap.options" | "swap.quote" | "swap.start" | "swap.refund" | "invoice.sweep"
  request,    // the raw framework request — read YOUR OWN session/cookie/JWT/header here
  resource,   // { order_id?, checkout_id?, amount_msats?, attempt_id? } when known
  token,      // the presented capability token, or null
}
```

If you provide no `authorize`, the default policy allows Tier 1, allows Tier 2 iff a valid
capability token is presented, and denies all Tier 3. That makes the package usable with zero
auth config on a site with no accounts, and safe by default.

### Presets

Two presets cover the dominant host shapes so you don't hand-write the tiered policy:

```ts
import { guestCheckout, withUser } from "@openreceive/http";

// Guest checkout (no accounts): anonymous checkout, reads gated by the per-order capability token.
authorize: guestCheckout();
// (optionally allow admins to sweep: guestCheckout({ allowSweep: (ctx) => isAdmin(ctx.request) }))

// User/account app: your own login owns the order.
authorize: withUser((request) => currentUserFromMySession(request), {
  ownsOrder: (user, ctx) => orderBelongsTo(user, ctx.resource.order_id),
  isAdmin: (user) => user.admin,
});
```

Both are built on a precomputed `ctx.tokenValid` boolean, so a hand-rolled `authorize` can use
it too instead of calling the token manager. In Ruby: `OpenReceive::Server::Presets.guest_checkout`
and `.with_user`.

## Capability tokens

On checkout creation the route mints a high-entropy (≥128-bit), URL-safe per-order token,
returns it once as `order_access_token`, **and** sets it as an httpOnly cookie
(`openreceive_order_token`) path-scoped to `{prefix}/orders/{order_id}` (SameSite=Lax; Secure over
https). Only its sha256 hash is stored. Reads present the token as `Authorization: Bearer <token>`,
`X-OpenReceive-Order-Token`, **or** the cookie — the route verifies by hashing and comparing to the
stored hash for that order. Tokens are per-order, so anonymous payers can poll their own order
without a login and cannot read anyone else's.

**You almost never handle the token yourself.** The OpenReceive browser client stores it from
checkout creation and auto-attaches it (by `order_id`) on every status poll and swap call, and
same-origin browsers also carry the cookie automatically. The self-contained
`<Checkout orderId />` component (see [Frontend Checkout](frontend-checkout.md)) does all of this
for you. Token hashing is identical across the Node and Ruby engines
(`spec/test-vectors/capability-token.json`).

## Amount authority

The create-checkout route MUST NOT trust a client-supplied price. `getCheckoutAmount` is
**required** at handler construction — omitting it throws. The create body is
`{ order_id, memo?, description_hash?, metadata? }`; a client-supplied `amount` /
`sats` / `usd` is rejected with 400. The route obtains the price ONLY from the hook:

```ts
getCheckoutAmount = ({ orderId, request }) => ({ amount: { currency: "USD", value: priceForOrder(orderId) } });
// or { amount: { sats: 21000 } } or { amount: { currency: "EUR", value: "9.99" } }
// return null → 404 (order not found); throw → 400 (validation)
```

Client-priced / tip-jar checkouts are still possible: honor a payer-chosen amount
**inside** `getCheckoutAmount` (for example from `metadata` or your own session), validate
it, and return it. That makes "trust the client" an explicit host decision, not a
framework default.

## Mounting

### Framework-agnostic (Web `Request`/`Response`)

```ts
import { createOpenReceiveHttpHandler } from "@openreceive/http";
const handler = createOpenReceiveHttpHandler({ service, authorize, getCheckoutAmount, prefix: "/openreceive" });
const response = await handler(request); // (Request) => Promise<Response>
```

### Express

```ts
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
// or: import { openReceiveExpress } from "@openreceive/express";
app.use(openReceiveExpress({ service, authorize, getCheckoutAmount }));
```

### Fastify

```ts
import { openReceiveFastify } from "openreceive/fastify";
// or: import { openReceiveFastify } from "@openreceive/fastify";
await fastify.register(openReceiveFastify, { service, authorize, getCheckoutAmount, prefix: "/openreceive" });
```

### Next.js (App Router)

```ts
// app/openreceive/[...openreceive]/route.ts
import { openReceiveNextHandlers } from "openreceive/next";
// or: import { openReceiveNextHandlers } from "@openreceive/next";
export const { GET, POST } = openReceiveNextHandlers({ service, authorize, getCheckoutAmount });
```

### Rails

```ruby
# config/routes.rb
mount OpenReceive::Engine => "/openreceive"
```

Engine controllers inherit from your `config.parent_controller` (set it to
`ApplicationController`), so they automatically get your CSRF protection, `authenticate_user!`,
and `current_user`. Configure the hooks in an initializer:

```ruby
OpenReceive.configure do |config|
  config.parent_controller = "ApplicationController"
  config.authorize = ->(ctx) { ctx[:action] == "checkout.create" || current_user_owns?(ctx) }
  config.get_checkout_amount = ->(ctx) {
    { amount: { currency: "USD", value: price_for_order(ctx[:order_id]) } }
  }
end
```

See `docs/guides/quickstart-rails.md` for the full Rails walkthrough.
