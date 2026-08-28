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

## Four stacks, one shop

From the repository root:

```sh
cp -n .env.example .env      # set a receive-only NWC_URI

npm run demo node            # Express + SQLite                  :3000
npm run demo static          # static HTML, no framework         :3001
npm run demo nextjs          # Next.js app router + SQLite       :3002
npm run demo buttons         # Rails + Postgres                  :3003
```

For an edit-reload loop, run the stack's own `npm run dev` (or `bin/dev` for
Rails) outside Docker — see each stack's README.

## The layout

```
examples/buttons/
  images/                the six webp product files and two hero crops.
                         ONE copy; every stack reads this directory.
  shared/
    shop-catalog.json    the six products — THE seed source of truth
    shop-types.ts        wire shapes, route paths, formatters. Imports
                         nothing but the standard library.
    shop.css             the whole design, as global `or-` classes
    http.ts              getJson / postJson, and the feed's cache rule
    bootstrap.ts         the bootstrap fetch
    checkout-resume.ts   `/checkout/:uuid`, and the way back to a deposit
    client/              React + Mantine + mobx-keystone: the theme, three
                         stores, twelve components.
    client-vanilla/      the no-framework client. No React.
    server-node/         SQLite, migrations, the five handlers, the three
                         hooks, the Express host.
  server/
    node-express/        Express + Vite, four framework tabs
    static-html-small-api/  Express + Vite, hand-written DOM
    nextjs-fullstack/    Next.js app router
    rails/               Rails 8.1 + Postgres + Shakapacker
```

The shop UI, the stores, the wire types and the Node server live ONCE, in
`shared/`. Each stack under `server/` is a thin host: its own routing, its own
database idiom, its own build. Nothing that renders a button or names a column
is duplicated per stack.

The directory names carry the boundary, so a wrong import is visible in the
diff rather than discovered at build time:

- The shared ROOT is what every client shares — the wire types, the
  stylesheet, the fetch helpers. `shop-types.ts` imports nothing but the
  standard library.
- `client/` is React. `client-vanilla/` is no framework. **Neither imports the
  other**, which is why `@mantine/*` and `mobx*` are absent from the
  static-html workspace: an accidental import fails to resolve.
- Rails never imports `shared/server-node/**` — that is SQLite and Express,
  and Rails has ActiveRecord. `server/rails/script/check-shared-boundary.rb`
  enforces it.

### The checkout renderer is pluggable

The catalog, the cart, the receipt and the feed are identical everywhere. The
PAYMENT step is not, so `ShopPanel` takes a `renderCheckout` prop. That prop is
the seam; everything above and below it is shared.

| stack | what it plugs in |
| --- | --- |
| rails, nextjs | the mobx-keystone `CheckoutStage`, driving `@openreceive/browser/headless` directly |
| node-express | the packaged `<Checkout>`, behind React / Vue / Svelte / Angular tabs |
| static-html | the packaged `<openreceive-checkout>` custom element |

node-express is the one stack whose payment screen differs from the others,
and that is its job: it is the demo the four wrapper packages need.

### The order has a URL

The checkout lives at `/checkout/:reference` on every stack, and every server
serves the SPA there. This is not decoration. A payer with a stablecoin deposit
in flight has no account and gets no email from us, so the order's uuid is the
only thing that can return them to their payment — and a deposit that arrives
short or late becomes `refund_required`, which the payer claims on a second
visit, after leaving to fetch an address from another wallet.

So the shop puts the uuid in the address bar the moment the order exists, shows
it with a copy button beside what is being bought, and takes a pasted uuid back
in through a quiet "already have an order id?" box on the catalog. On the refund
screen — which REPLACES the deposit panel rather than sitting under it, because
"send 15.01 USDT to this address" beside a refund notice gets sent twice — that
copy affordance becomes the loud one.

Restoring the order is `shared/checkout-resume.ts`, over the packaged
`createGuestCheckoutResume` and this shop's own `GET /shop/orders/:reference`.
Restoring the ATTEMPT is the part that is easy to miss: `/checkouts/prepare`
carries no attempts, so an order restored on its own opens on the method grid.
The two custom-UI stacks keep the attempt's `payment_hash` and reopen it with
`POST /swaps/status`, which addresses one attempt with no expiry window; the two
that mount the packaged checkout leave that to the drop-in, where the payer
re-picks their coin. [Swap refunds](../../docs/guides/swap-refunds.md) is the
whole of that argument.

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

### On Rails it is pushed; on Node it polls

**Only the Rails stack pushes.** The three Node stacks keep the checkout's own
poll loop and refresh the feed every thirty seconds. Both paths land in the
same idempotent store methods, so the difference is latency and never
correctness — which is exactly why the shared stores expose
`setPushConnected` / `refreshFromPush` and know nothing about how news
arrives.

On Rails, settlement rides ActionCable over solid_cable. Two streams, for two
audiences:

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
feed drops back to thirty seconds — which is what every Node stack does all the
time. A dropped websocket costs latency, never correctness.

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
  note at the top of `shared/shop.css`. Every stack pins the checkout to light
  for the same reason.
- **The Node stacks do not push settlement.** Only Rails does. Adding it means
  picking a transport per stack and is orthogonal to what these demos show.
- **There is no URL resume.** Closing the tab mid-checkout loses the reference
  on the Node stacks; the order row survives and is still payable, but the
  browser has no way back to it. That is the OpenReceive URL-resume issue, not
  a shop-table problem.
