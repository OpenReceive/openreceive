# OpenReceive

OpenReceive adds uncensorable, global, permissionless inbound payments to any
website or app using open-source packages and decentralized protocols. A server
in your application creates and verifies one Bitcoin Lightning BOLT11 invoice
through a wallet you control, while the checkout gives purchasers friendly route
guidance so they can start from a credit card, bank account, Bitcoin wallet,
stablecoin balance, exchange, onramp, or swap service and complete an instant
payment on your website or app.

OpenReceive is not a bank, exchange, wallet, broker, custodian, or payment
processor. It does not transmit money or hold customer funds. Your app brings a
server-side Nostr Wallet Connect (NWC / NIP-47) connection to a wallet you
control, and OpenReceive helps your backend create and verify receive-only
invoices.

The v0.1 reference path is contract-first and server-owned:

- `spec/` is the source of truth for schemas, shared data, and test vectors.
  `spec/openapi/openreceive-http.v1.yaml` is the shipped route contract.
- `packages/js/` contains the core contracts, Node NWC service, the shipped HTTP
  routes (`@openreceive/http`) and thin framework adapters
  (`@openreceive/express`, `@openreceive/fastify`, `@openreceive/next`), the
  `openreceive` umbrella (`openreceive/express|fastify|next|react|…`), browser
  helpers, provider data, testkit, elements, and frontend framework packages.
- `packages/ruby/` contains the dependency-free `openreceive` core plus the
  `openreceive-server` (Service + store + Rack app) and `openreceive-rails`
  (mountable engine) gems — a full second settlement engine.
- `examples/hello-fruit/server/` contains the Express demo with React, Vue,
  Svelte, and Angular checkout tabs, plus static HTML + small API and Next.js
  fullstack Hello Fruit demos.
- `demos/deploy/` contains public-safe hosted demo deployment templates.
- `tools/` holds validation, conformance, package-smoke, docs, and live-wallet
  smoke helpers.

## Ship The Routes, Keep Your Auth

Instead of hand-writing controllers, mount OpenReceive's routes and keep 100% of
authentication in your app. OpenReceive never inspects your session — it calls
your `authorize` and `getCheckoutAmount` hooks and obeys them.

```ts
import express from "express";
import { createOpenReceive, openReceiveExpress } from "openreceive/express";

// 1. Price the order (create-checkout only — never trusts a client price)
const getCheckoutAmount = ({ orderId }) => ({
  amount: { currency: "USD", value: priceForOrder(orderId) },
});

// 2. Mount (add onPaid on createOpenReceive when you need fulfillment)
const service = await createOpenReceive();
const app = express();
app.use(express.json());
app.use(openReceiveExpress({
  service,
  getCheckoutAmount,
  // Tier 2 reads require the per-order capability token; Tier 3 (sweep) fails closed.
  authorize: ({ action, token, resource }) =>
    action === "checkout.create" || validToken(token, resource.order_id),
}));
```

Rails hosts mount the engine and inherit their own CSRF/auth/current_user:

```ruby
# config/routes.rb
mount OpenReceive::Engine => "/openreceive"
```

See `docs/guides/routes.md` for the full route contract, tiers, and capability
tokens.

## Run A Demo

The dockerized Hello Fruit demos serve a small store UI where you can add fruit
stickers to a cart, create an app order, and pay its Lightning invoice. Pick a
stack:

```sh
npm run demo node      # Express + React/Vue/Svelte/Angular http://localhost:3000
npm run demo static    # Static HTML + small API   http://localhost:3001
npm run demo nextjs    # Next.js fullstack         http://localhost:3002
```

Each command creates a root `openreceive.yml` if missing, validates
`OPENRECEIVE_NWC`, and then runs that demo's Docker Compose stack with local port publishing. The JS
demo stacks start a local Postgres container, run the OpenReceive invoice
migration, and record the OpenReceive
schema version before store queries. The JS local overrides run Vite or Next.js
development servers inside Docker so browser errors stay readable. The Ruby
`openreceive-rails` engine is a separate mountable gem (see
`docs/guides/quickstart-rails.md`), not a bundled demo stack.
Buying fruit creates a live Lightning invoice through your own wallet, so set a
valid receive-only NWC code (for example from Rizful or Alby Hub) in
`openreceive.yml` before starting a demo. Demos need a valid receive-only NWC
code before startup.
The JS demos let the browser choose any configured price-feed currency, BTC, or
sats; `/create_order` builds the order, quotes or converts the total, and
returns the order and checkout to the browser.
Optional automated swaps live in the same server-only `openreceive.yml` under
`swap.providers`. When provider `key` and `secret` are present,
`createOpenReceive()` loads those providers automatically.

Extra arguments after `--` are forwarded to `docker compose up`, for example to
run detached: `npm run demo node -- -d`.

## Current Status

This repository has the v0.1 JS reference path in place. The current gate keeps
schemas, vectors, generated contracts, package artifacts, demos, secret scans,
release metadata, deployment templates, and docs aligned before broader SDK
work proceeds.

Run the fast day-to-day gate (validate, lint, typecheck, JS tests, package smoke):

```sh
npm run test:ci:core
```

Run the full gate (core + Ruby, demos, release/workflow checks, live NWC):

```sh
npm run test:ci
```

Run only the contract and secret checks when iterating quickly:

```sh
npm test
```

Validate hosted-demo deployment templates:

```sh
npm run check:demo-deploy
```

Validate release-readiness metadata:

```sh
npm run check:release
```

Validate public workflow skeletons:

```sh
npm run check:workflows
```

Run the live-wallet smoke harness:

```sh
npm run test:live:nwc
```

The live smoke command reads `OPENRECEIVE_NWC` from `openreceive.yml` and skips
when it is absent.

## Product Boundary

OpenReceive creates a Lightning invoice for each checkout action and can show
payer-side route guidance for wallets, exchanges, swap services, fiat onramps,
cards, bank accounts, Bitcoin, or stablecoins that may be able to reach that
invoice.
Provider routes are suggestions, not payment guarantees. The payer chooses and
uses third-party services outside OpenReceive.

Browser, mobile, and static frontend code never get the receive-only NWC code.
Live checkout always needs a backend component controlled by your application.

## Docs

Developer docs start at `docs/guides/README.md` and are indexed by
`docs/manifest.json`.

- `docs/guides/quickstart-node.md` is the current working backend quickstart.
- `docs/guides/frontend-checkout.md` covers browser helpers and UI packages.
- Status refreshes are request-driven; OpenReceive does not run background
  settlement tasks.
- `docs/internal/README.md` is the contributor entry point for architecture,
  conformance, release, package ownership, and ADR docs.
