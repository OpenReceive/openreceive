# Buy a Button

A shop that sells six virtual OR pin badges, $1 to $10, over Lightning or a
stablecoin swap — and shows every paid order on the site to every visitor.

The buttons are not the point. The point is where the line falls between YOUR
data and OpenReceive's:

- **Your tables.** `shop_products` (the price authority), `shop_users` (a uuid
  in a signed cookie, and nothing else), `shop_orders` and `shop_order_items`.
- **OpenReceive's tables.** `openreceive_payments` and `openreceive_meta`, in
  the same database, owned by the library.
- **The bridge.** Three lambdas. `authorize`, `amount_for`, `on_paid`.

OpenReceive never sees an order, a cart, a price, a product or a download. If a
change to this demo ever seems to need a fourth hook, that is a signal the
boundary moved.

## What the visitor sees

One panel with two tabs.

**Buy a button** — six badges, add to cart, checkout, pay, download the
artwork.

**Recent orders** — every paid order on the site, to any visitor: the amount,
what was bought, an anonymous buyer handle, and how long ago. Your own rows are
marked "You".

## The acceptance demo

This is the sentence that says whether it works, and it is run by hand:

> Buy a $1 Safety Orange. Open the site in a DIFFERENT browser, open Recent
> orders, and see $1.00 next to a UUID. Go back to the first browser: the same
> UUID is marked "You". Close that browser, reopen it, and the download still
> works.

If it does not do that, the persistence is not real regardless of what the
schema looks like.

## Running it

From the repository root:

```sh
cp -n .env.example .env      # set a receive-only NWC_URI
npm run demo buttons         # Rails + Postgres, :3003
```

For an edit-reload loop, run the stack's own `bin/dev` outside Docker — see
[`server/rails/README.md`](server/rails/README.md).

## The layout

```
examples/buttons/
  images/                the six webp product files and two hero crops.
                         ONE copy; every stack reads this directory.
  shared/
    shop-catalog.json    the six products — THE seed source of truth
    shop-types.ts        wire shapes, route paths, formatters. Imports
                         nothing but the standard library.
    client/              React + Mantine + mobx-keystone: the theme, the
                         stylesheet, three stores, twelve components.
  server/
    rails/               Rails 8.1 + Postgres + Shakapacker
```

The shop UI, the stores and the wire types live ONCE, in `shared/`. Each stack
under `server/` is a thin host: its own routing, its own database idiom, its own
build. Nothing that renders a button or names a column is duplicated per stack.

The directory names carry the boundary, so a wrong import is visible in the
diff rather than discovered at build time:

- Rails imports `shared/shop-types.ts` and `shared/client/**`, and never
  `shared/server-node/**` — that is SQLite and Express, and Rails has
  ActiveRecord. `server/rails/script/check-shared-boundary.rb` enforces it.
- `shared/shop-types.ts` imports nothing but the standard library. It is the
  one module every stack shares, so it must stay free of React, of Node, and of
  any package that is not already a dependency everywhere.

### The checkout renderer is pluggable

The catalog, the cart, the receipt and the feed are identical everywhere. The
PAYMENT step is not necessarily, so `ShopPanel` takes a `renderCheckout` prop.
Rails plugs in the mobx-keystone `CheckoutStage`, which drives
`@openreceive/browser/headless` directly. That prop is the seam; everything
above and below it is shared.

## The seven invariants

1. **The price is never on the wire.** Only `{ sku, quantity }` is.
2. **The reference is minted once**, before checkout, and survives every retry.
   A fresh id per attempt leaves one cart payable twice.
3. **Fulfillment is one conditional UPDATE.** The `WHERE` clause is the lock,
   and it returns whether THIS caller won.
4. **`paid` is written only inside the engine's settlement transaction.**
5. **The browser never decides an order was fulfilled** — it re-reads the row.
   The download is gated on the row, not on anything the browser says.
6. **Possession of an order id is a claim, not proof.** Another visitor's order
   is 404, never 403 — do not confirm that an id exists.
7. **Untrusted input is format-checked before it reaches the database.** These
   are anonymous routes and a malformed uuid literal raises in Postgres.

## Identity

A signed cookie holding a `shop_users.id`, and nothing else. No email, no name,
no password, no IP, no OAuth. A user with no credentials is the feature: the
row exists so an order can outlive a browser session, and so the public feed
has something anonymous to attribute a purchase to.

**Two uuids per user, on purpose.** `id` is the ownership token in the cookie
and is never rendered; `public_ref` is the handle the feed shows. Not because
publishing `id` would be exploitable — the cookie is signed, so knowing its
plaintext buys nothing. Because a published `id` stops being safe the moment
anything else accepts a bare uuid: a debug parameter, an admin lookup, a
well-meaning "simplification" to an unsigned cookie. One column removes the
whole category, and this demo exists to be copied from.

Identity is minted on the shop routes and the page that renders the shop, never
on every route: a demo that mints a user row for each crawler hit on a health
check is a junk-row generator.

## The recent-orders feed

`GET /shop/recent_orders` — public, unauthenticated, paid orders only, newest
first, capped at a constant 25 (a larger `?limit=` is ignored), cached ten
seconds.

It carries no order id, no `download_path`, no `payment_hash`, no
`shop_users.id` and nothing off the engine's tables. That list is asserted
against the serialized body in `test/controllers/shop_feed_test.rb`, not left
as a comment. The payload is built from an explicit whitelist — never a
reject-list, never an `.except(…)`.

It carries no per-visitor field either, which is what lets one public response
be cached for everyone; the SPA draws the "You" badge itself by comparing each
row's `buyer` against the `public_ref` in its bootstrap payload.

**Paid-only is also the anti-spam design.** Anyone can POST an order as many
times as they like — it is an unauthenticated route that writes a row. If the
feed showed unpaid orders it would be a free billboard. An entry here costs a
real payment.

### It is pushed, and it also polls

Settlement rides ActionCable over solid_cable. Two streams, for two audiences:

| channel | who | envelope |
| --- | --- | --- |
| `ShopFeedChannel` | everyone, no identity | `orders-changed` |
| `ShopOrderChannel` | the payer, authorized against the signed cookie | `order-paid` |

**Neither envelope carries order data.** They say "something changed"; the
client re-reads the HTTP route. That is deliberate — the feed's payload
whitelist lives in exactly one place on the server, and a second serializer on
a socket is the obvious way to leak `download_path` into a public broadcast.
The feed response is already cached ten seconds, so a burst of settlements
collapses into one query per visitor.

**The push is scheduled, never sent from the hook.** `config.on_paid` runs
INSIDE OpenReceive's settlement transaction, where the rule is database writes
only: a broadcast sent from there survives a rollback and tells every browser
to re-read an order that was never committed. The initializer schedules it with
`ActiveRecord.after_all_transactions_commit`, and there is a test that rolls the
transaction back and asserts silence.

**Polling did not go away.** With the socket connected the feed still polls
every two minutes, and the checkout keeps its own poll loop; without it the
feed drops back to thirty seconds. Both paths land in the same idempotent store
methods. A dropped websocket costs latency, never correctness.

### Why the cable is database-backed

Because of the second container. `compose.yml` runs
`bundle exec rails openreceive:notifications` — the engine's one long-lived
task, listening for NWC-02 `payment_received` and running a periodic reconcile
pass as the safety net for notifications missed while it was down. It settles
orders in a process that holds **none** of the payers' websockets. solid_cable
is how its broadcast reaches the web container: through the database they
already share. An in-memory adapter would drop every push that worker makes and
the demo would fall back to polling with no sign anything was wrong.

The worker is optional. Without it, settlement still happens — every engine
request runs the durably gated opportunistic reconcile — it just waits for the
next OpenReceive call instead of landing the moment the wallet reports the
payment.

## Known simplifications

- **Abandoned `awaiting_payment` rows accumulate forever.** There is no sweep.
  Knowingly unswept: the feed is paid-only, so they cost storage and nothing
  else.
- **The cart is not persisted.** It stays an in-memory `Record<sku, number>`
  and is lost on refresh. With a user row it becomes easy, but it is not needed
  to prove persistence and it adds a write path to every quantity click.
- **The thumbnail and the download are the same file.** A higher-resolution
  download is the obvious upgrade; `image_name` is deliberately a column rather
  than a derivation so that day needs no renaming.
- **There is no admin surface for editing products.** A console and the seed
  file are the editing story.
- **There is no dark mode**, and adding one is not a piecemeal change — see the
  note at the top of `shared/client/shop.css`.
