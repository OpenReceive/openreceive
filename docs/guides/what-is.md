# What Is OpenReceive

OpenReceive adds uncensorable, global, permissionless inbound payments to any
website or app using open-source, verifiable technology that cannot be shut down.

OpenReceive is not a bank, exchange, payment processor, wallet backend,
custodian, broker, or money transmitter. It does not hold funds, exchange
assets, route money, or operate customer accounts.

OpenReceive's front end checkout helpers give purchasers friendly
route guidance so they can start from a Bitcoin wallet, stablecoin balance,
exchange, or swap service and complete an instant payment on your website or
app.

OpenReceive does three narrow things:

1. Creates a BOLT11 invoice for a user-triggered checkout action through your
   app's server-side NWC wallet connection.
2. Lets the frontend show QR, copy, open-wallet, countdown, and friendly route
   guidance for that invoice.
3. Lets the backend verify payment before app-owned fulfillment runs.

Provider routes are payer-side suggestions. A wallet, exchange, swap service,
Bitcoin wallet, or stablecoin balance may be the purchaser's starting point,
but reaching the Lightning invoice happens through third-party services outside
OpenReceive.

## Runtime Model

OpenReceive runs inside your normal web process. Your app mounts OpenReceive's
routes with a required `prepareCheckout` hook that returns the amount to charge
on **POST `/prepare`**. Your frontend then renders the checkout UI:

```tsx
<Checkout orderId={order.id} onSummary={setOrder} />
```

Pass the order id from prepare. Create mode always reloads that order's summary
(cart/total) from `GET /openreceive/orders/:id/summary` so a refresh can redraw
host UI. Opt into `/checkout/:orderId` History API sync with `syncUrl` only if
you want Checkout to own the address bar. The component creates the checkout
against the mounted routes and polls order status there.
Checkout creation, order-status reads, admin pages, or background tasks may
advance at most one bounded server-side `list_transactions` page through the
global sweep.

```text
your app             prepareCheckout validates cart / returns amount (+ optional summary)
mounted OpenReceive  POST /prepare persists amount; create never trusts a client price
browser checkout     <Checkout orderId> creates, polls, restores summary on refresh
wallet scan          happens only inside server-side OpenReceive calls
```

The OpenReceive store is the only thing coordinating payment state across
processes.

Local invoice expiry is not a payment decision. If no browser, admin, cron,
worker, or app request calls OpenReceive, no settlement scan runs (opt into
`startSweeper` on long-lived idle deployments — see
[Settlement Sweeps](../internal/settlement-sweeps.md)).

OpenReceive packages provide their own invoice storage (namespaced tables, not
your ORM models). When `store` is omitted, a Postgres
`DATABASE_URL` / `DATABASE_PRIVATE_URL` is adopted automatically; otherwise
local development falls back to `local-sqlite`. Your app keeps its own orders,
carts, users, and fulfillment tables. See [Storage](storage.md).

- Express / Fastify / Next adapters (or `openreceive/express|fastify|next`).
- Rails engine (`openreceive-rails`).
- Equivalent native integrations in later ecosystems.

The browser or mobile app receives only display-safe invoice data. The
receive-only NWC code, invoice creation, payment verification, status refresh,
and `onPaid` fulfillment stay server-side.
