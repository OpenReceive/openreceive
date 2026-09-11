# OpenReceive examples

See a complete checkout integration: create an order, collect a payment,
verify wallet settlement, and unlock fulfillment. These examples connect
OpenReceive to real application databases and a shared product catalog.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

[`wordpress/`](wordpress) runs a real WordPress + WooCommerce shop, with the
OpenReceive payment gateway, checkout blocks, MySQL and the shared product
catalog. Start it with `npm run demo wordpress` (port 3009).

[`buttons/`](buttons) — **Buy a Button**, a shop for six virtual OR pin badges,
built on real persistence: a products table, a signed-cookie visitor table, an
orders table, and a public feed of every paid order on the site. Read it to see
where the line falls between YOUR data and OpenReceive's — three lambdas are the
entire bridge.

The examples cover Node.js, Ruby, Python, and PHP. Pick the framework you
use and follow its README for the host integration:

| Stack | Example | Application quickstart |
| --- | --- | --- |
| Express | [Express demo](buttons/server/node-express/README.md) | [Express](../docs/guides/quickstart-node.md) |
| Fastify | [Fastify demo](buttons/server/fastify/README.md) | [Fastify](../docs/guides/quickstart-fastify.md) |
| Next.js | [Next.js demo](buttons/server/nextjs-fullstack/README.md) | [Next.js](../docs/guides/quickstart-next.md) |
| Rails | [Rails demo](buttons/server/rails/README.md) | [Rails](../docs/guides/quickstart-rails.md) |
| Django | [Django demo](buttons/server/django/README.md) | [Django](../docs/guides/quickstart-django.md) |
| FastAPI | [FastAPI demo](buttons/server/fastapi/README.md) | [FastAPI](../docs/guides/quickstart-fastapi.md) |
| Plain PHP | [PHP demo](buttons/server/php-plain/README.md) | [PHP](../docs/guides/quickstart-php.md) |
| Laravel | [Laravel demo](buttons/server/laravel/README.md) | [Laravel](../docs/guides/quickstart-laravel.md) |
| Static HTML | [Static demo](buttons/server/static-html-small-api/README.md) | [Frontend checkout](../docs/guides/frontend-checkout.md) |
| WooCommerce | [WordPress demo](wordpress/README.md) | [WooCommerce](../docs/guides/quickstart-woocommerce.md) |

The framework quickstarts are the shortest path for your own application.
The demos show a complete shop, including the application code surrounding
the payment integration.

## Running a demo

Every demo runs from the repository root:

```sh
cp -n .env.example .env      # set a receive-only NWC_URI
npm run demo node            # Buy a Button — Express + React/Vue/Svelte/Angular  :3000
npm run demo static          # Buy a Button — static HTML, no framework           :3001
npm run demo nextjs          # Buy a Button — Next.js app router                  :3002
npm run demo buttons         # Buy a Button — Rails + Postgres                    :3003
npm run demo fastify         # Buy a Button — Fastify + React, the minimal host   :3004
npm run demo php             # Buy a Button — plain PHP, no framework          :3008
npm run demo laravel         # Buy a Button — Laravel + Postgres               :3005
npm run demo django          # Buy a Button — Django + Postgres                :3006
npm run demo fastapi         # Buy a Button — FastAPI                          :3007
npm run demo wordpress       # Buy a Button — WordPress + WooCommerce          :3009
```

`npm run demo` builds the image and runs the production server inside it. The
`compose.override.yml.example` each variant ships publishes the port and does
nothing else. Run demo applications and their backing services in Docker;
builds, tests and browser automation may run on the host.

## Running the demo against fakes (no wallet)

The demos provide explicit testkit modes that fake the wallet, swap provider
and price feed while exercising the actual engine and database. Follow each
example's Docker instructions. For WordPress:

```sh
docker compose -p openreceive-wp-test -f examples/wordpress/compose.yml \
  -f examples/wordpress/compose.override.yml.example \
  -f examples/wordpress/compose.testkit.yml up --build -d --wait
npm run test:wordpress
npm run test:e2e:wordpress
```

The Node stacks share `@openreceive/testkit`; Rails has a port of it in
`buttons/server/rails/lib/button_shop/testkit/`, with the same fixtures. Python and PHP engines ship their own matching fakes.
The shared Playwright scenarios exercise these integrations. What is faked is the wallet, the swap
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

Guardrails keep the mode out of production: production compose files may not set
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
  copy of the artwork that the demos serve. Nothing re-declares a sku, a
  price or an artwork path.
- **The shop UI lives once.** `buttons/shared/` holds the stores, the
  components and the wire types; each stack under `buttons/server/` is a thin
  host. The directory names carry the boundary so a wrong import shows up in
  the diff.
