# OpenReceive examples

One app lives here, built four times.

[`buttons/`](buttons) — **Buy a Button**, a shop for six virtual OR pin badges,
built on real persistence: a products table, a signed-cookie visitor table, an
orders table, and a public feed of every paid order on the site. Read it to see
where the line falls between YOUR data and OpenReceive's — three lambdas are the
entire bridge.

It runs on **Rails + Postgres**, **Express + SQLite**, the **Next.js app
router**, and **static HTML with no framework at all**. The shop itself — the
UI, the stores, the wire types and the Node server — lives ONCE in
`buttons/shared/`; each stack under `buttons/server/` is a thin host with its
own routing, database idiom and build. The stacks deliberately exercise
different integration forms so every surface stays covered — for the minimal
happy path, follow the quickstarts below instead.

For the smallest possible integration, follow the
[Node quickstart](../docs/guides/quickstart-node.md) or the
[Rails quickstart](../docs/guides/quickstart-rails.md) — the Rails guide walks
`bin/rails generate openreceive:install`, whose output is exercised by the
engine gem's generator tests and by the Rails demo here.

## Running a demo

Every demo runs from the repository root:

```sh
cp -n .env.example .env      # set a receive-only NWC_URI
npm run demo node            # Buy a Button — Express + React/Vue/Svelte/Angular  :3000
npm run demo static          # Buy a Button — static HTML, no framework           :3001
npm run demo nextjs          # Buy a Button — Next.js app router                  :3002
npm run demo buttons         # Buy a Button — Rails + Postgres                    :3003
```

`npm run demo` builds the image and runs the production server inside it. The
`compose.override.yml.example` each variant ships publishes the port and does
nothing else. For an edit-reload loop, run the variant's own `npm run dev`
(or `bin/dev` for the Rails demo) outside Docker.

## Running the demo against fakes (no wallet)

All four stacks boot against in-process fakes when `DEMO_WALLET=testkit` is
set — no `NWC_URI`, no LSC keys, no network, full checkout:

```sh
cd buttons/server/node-express
DEMO_WALLET=testkit npm run dev

cd buttons/server/rails
DEMO_WALLET=testkit bin/dev          # Postgres is still Postgres
```

The three Node stacks share `@openreceive/testkit`; Rails has a port of it in
`buttons/server/rails/lib/button_shop/testkit/`, with the same fixtures, so one
Playwright suite can drive any of them. What is faked is the wallet, the swap
provider and the price feed — never the engine, the hooks or the database.

A test-only control surface is mounted under `/__testkit` (hard-404 in every
other mode):

- `POST /__testkit/settle { payment_hash }` — settle an invoice (emits the
  NWC-02 notification)
- `POST /__testkit/expire { payment_hash }` — force expiry
- `POST /__testkit/swap-step { provider_order_id | pay_in_asset, state }` —
  advance a scripted swap (`refund_required`/`attention` route through the
  fake's force helpers)
- `GET /__testkit/state` — current fixtures

Guardrails keep the mode out of production: no compose file may set
`DEMO_WALLET` (checked by `check:demo-containers`), and the client-bundle
scanner rejects any testkit marker in shipped demo bundles. The Playwright
suite (`npm run test:e2e` from the repo root) runs against exactly this mode;
`OPENRECEIVE_DEMO_DB` relocates the SQLite store for hermetic runs. See the
[host-testing guide](../docs/guides/host-testing.md) for testing your own
integration this way.

## The boundary these examples exist to show

- **The host owns orders, prices, and fulfillment.** Every variant creates its
  own order row first, then hands OpenReceive an order id. None of them lets the
  browser name an amount.
- **The receive-only NWC code never leaves the server.** It is read from the
  repository-root `.env` by server code only; no variant ships it to a bundle.
- **Demos import the shared `@openreceive/*` UI — they never fork it.** When a
  stack needs different markup, it composes the packaged components and class
  registries rather than copying them. The shop builds its own checkout on
  `@openreceive/browser/headless` — the supported surface OpenReceive's own
  renderers are built on — which is what proves the headless engine drives a
  checkout from a non-React store. node-express plugs the PACKAGED checkout
  into that same shop instead, behind four framework tabs, so the wrapper
  packages keep a demo too.
- **Product data has one source.** `buttons/shared/shop-catalog.json` is the
  seed every stack's data migration reads, and `buttons/images/` holds the one
  copy of the artwork that all four stacks serve. Nothing re-declares a sku, a
  price or an artwork path.
- **The shop UI lives once.** `buttons/shared/` holds the stores, the
  components and the wire types; each stack under `buttons/server/` is a thin
  host. The directory names carry the boundary so a wrong import shows up in
  the diff.
