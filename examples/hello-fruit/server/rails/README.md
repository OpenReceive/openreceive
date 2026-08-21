# Hello Fruit — Rails

Rails Hello Fruit demo that matches the Node demos: fruit catalog, currency
picker (USD / BTC / SATS), OpenReceive checkout (Lightning + USDT/USDC swaps),
resume at `/checkout/:orderId`, and post-pay sticker delivery.

Unlike the Node demos (which mount the self-contained `<Checkout>` widget),
this demo drives the checkout with its own **MobX Keystone stores**: one ERB
view mounts a React SPA from a `#__app_bootstrap` JSON blob, every server
round-trip is a `@modelFlow`, and payment state has exactly one sink — a poll
result and an ActionCable push land in the same idempotent store action, so
the UI can never flip a settled screen back to "waiting". The visual layer
stays the shared npm packages: components come from `@openreceive/react`
(`QRCode`, `WaitingState`, `PaymentData`, `renderSwapDepositPanel`,
`TransactionDetails`, …) and every class string from
`@openreceive/browser`'s `ui-classes` design registry, so the design is
identical to the other demos. Only the method-wizard shell (whose selection
state lives in the store) is demo-owned markup.

Host persistence is **Postgres** (Docker Compose). Fruit rows live in
`products` (seeded from [`../../shared/fruits.json`](../../shared/fruits.json));
checkout attempts live in `openreceive_payments`. OpenReceive has no database
URL of its own.

BTC/USD pricing comes from the gem's built-in cached live feed
(`OpenReceive::Rates`, CoinGecko-compatible primary plus a fallback mirror;
`OPENRECEIVE_PRICE_FEED_*_URL` env vars override the URLs), and `/rates`
delegates to the same OpenReceive service the engine uses. Per-IP invoice
**rate limiting is on** (`config.rate_limiting = true`, 60/hour), matching the
node-express demo.

The browser never receives your NWC code.

## How payment state reaches the browser

- **Polling (baseline):** the store polls `POST /openreceive/payments/check`
  (plus `/openreceive/swaps/status` for a live swap) every 3 s, with an
  in-flight guard, Retry-After-aware backoff, and a terminal-state stop.
- **ActionCable over solid_cable (instant):** settlement is usually discovered
  out of band — by the request-path opportunistic reconcile (any OpenReceive
  call that wins the durable `openreceive_meta` gate) or the optional
  long-running `openreceive:notifications` NWC-02 worker container.
  `FulfillOrder` broadcasts an `{"message":"order-update","data":<summary>}`
  envelope on `OrderChannel` after the settlement transaction commits;
  solid_cable carries it through the shared Postgres (no Redis), and the
  browser's cable bridge folds it into the same store action polling uses.

## Assets

Shakapacker (webpack + swc) builds `app/javascript/packs/hello_fruit.js` into
`public/packs` with content-hashed names; `javascript_pack_tag` /
`stylesheet_pack_tag` read the manifest. Tailwind (v4 + daisyUI) compiles via
PostCSS, scanning the demo source plus `@openreceive/browser`'s `ui-classes.ts`
registry. Payment/provider icons and pay-tutorial images are copied next to
the emitted chunk (`/packs/js/assets/…`) so the packages' runtime
`new URL(..., import.meta.url)` resolution works — the same job the Node
demos do with a Vite copy plugin. The HTML shell is `Cache-Control: no-store`;
content-hashed pack files are immutable.

## Run with Docker

```sh
# from repo root
cp -n .env.example .env   # set receive-only NWC_URI
npm run demo rails
```

Open http://localhost:3003. Compose runs three services: `db`, the Rails web
app, and the optional `notifications` worker (`openreceive:notifications`, the
long-running NWC-02 wallet listener plus periodic reconcile safety net). After
a rebuild, refresh once — the HTML shell is never cached.

## Run locally

```sh
# terminal 1 — Postgres (or use compose db only)
docker compose -f examples/hello-fruit/server/rails/compose.yml up db

# from the repo root, once: install workspace deps
npm install

# terminal 2 — everything else via foreman
# (cp -n .env.example .env at the repo root first; set NWC_URI)
cd examples/hello-fruit/server/rails
bin/setup --skip-server   # gems, the public/stickers link, and db:prepare
bin/rails db:seed
bin/dev   # web + shakapacker-dev-server (settlement piggybacks on requests)
```

`public/stickers` is a git-ignored symlink to
[`../../shared/stickers`](../../shared); `bin/setup` creates it, and without it
every catalog thumbnail 404s.

Or run production-style, serving prebuilt packs from Rails:

```sh
npm run build -w @openreceive/example-rails
PORT=3003 bin/rails server
```

## Tests

```sh
# needs a reachable Postgres (e.g. the compose db service above)
bin/rails test   # or bin/ci for setup + tests + audits

# from the repo root — client typecheck and the wizard-port drift check
npm run typecheck -w @openreceive/example-rails
npm run test -w @openreceive/example-rails
```

`npm run test` runs [`script/check-wizard-drift.mjs`](script/check-wizard-drift.mjs):
the method wizard here is a hand port of the packaged one onto store state, so
the check fails when `@openreceive/browser/headless` gains or renames a wizard
export the port does not mirror. It reads the built `dist`, so run
`npm run build:packages` first.

The integration tests stub the NWC wallet and the price feed (static
$50,000/BTC), then exercise the demo's own glue over real routes:
catalog-priced order creation (USD and SATS), checkout mint via
`/openreceive/checkouts`, `payments/check` pending → settled,
`OpenReceive.reconcile!`, the `OrderChannel` settlement broadcast, `/rates`,
and sticker delivery gated on settlement. Shakapacker is stubbed with a test
manifest (no webpack in the suite). No network, no real wallet.

## Migrations

Host-owned migrations ship with the demo:

1. `create_products`
2. `create_orders`
3. `create_order_items`
4. `create_openreceive_tables` — `openreceive_payments` plus the `openreceive_meta`
   reconcile gate, one migration (from `rails generate openreceive:install`)
5. `create_solid_cable_messages` (single-database solid_cable)

For the smallest install walkthrough, see the
[Rails quickstart guide](../../../../docs/guides/quickstart-rails.md).
