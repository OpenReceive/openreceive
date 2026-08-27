# OpenReceive examples

Two apps live here.

[`buttons/`](buttons) — **Buy a Button**, a shop for six virtual OR pin badges,
built on real persistence: a products table, a signed-cookie visitor table, an
orders table, and a public feed of every paid order on the site. Read it to see
where the line falls between YOUR data and OpenReceive's — three lambdas are the
entire bridge. It runs on Rails + Postgres.

[`hello-fruit/`](hello-fruit) — the fruit-sticker shop, built three times over
three Node stacks. A complete checkout: catalog, cart, currency picker,
Lightning + swap rails, resume-after-refresh, post-pay delivery. The variants
are parity showcases: they deliberately exercise the composed/advanced
integration forms so every surface stays covered — for the minimal happy path,
follow the quickstarts below instead.

For the smallest possible integration, follow the
[Node quickstart](../docs/guides/quickstart-node.md) or the
[Rails quickstart](../docs/guides/quickstart-rails.md) — the Rails guide walks
`bin/rails generate openreceive:install`, whose output is exercised by the
engine gem's generator tests and by the Rails demo here.

## Running a demo

Every demo runs from the repository root:

```sh
cp -n .env.example .env      # set a receive-only NWC_URI
npm run demo node            # Hello Fruit — Express + React/Vue/Svelte/Angular  :3000
npm run demo static          # Hello Fruit — Static HTML + small API             :3001
npm run demo nextjs          # Hello Fruit — Next.js fullstack                   :3002
npm run demo buttons         # Buy a Button — Rails + Postgres                   :3003
```

`npm run demo` builds the image and runs the production server inside it. The
`compose.override.yml.example` each variant ships publishes the port and does
nothing else. For an edit-reload loop, run the variant's own `npm run dev`
(or `bin/dev` for the Rails demo) outside Docker.

## Running the demo against fakes (no wallet)

The node-express variant boots against in-process fakes when
`DEMO_WALLET=testkit` is set — no `NWC_URI`, no network, full checkout:

```sh
cd hello-fruit/server/node-express
DEMO_WALLET=testkit npm run dev
```

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
  demo needs different markup, it composes the packaged components and class
  registries rather than copying them. Buy a Button is the one place that
  builds its own UI, and it does so on `@openreceive/browser/headless` — the
  supported surface OpenReceive's own renderers are built on — which is what
  proves the headless engine drives a checkout from a non-React store.
- **Product data has one source.** `hello-fruit/shared/fruits.json` is the
  catalog for the three Node variants; `buttons/shared/shop-catalog.json` seeds
  the buttons. Nothing re-declares an id, a price or an artwork path.
- **The shop UI lives once.** `buttons/shared/` holds the stores, the
  components and the wire types; each stack under `buttons/server/` is a thin
  host. The directory names carry the boundary so a wrong import shows up in
  the diff.
