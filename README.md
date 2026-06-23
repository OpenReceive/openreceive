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
- `packages/js/` contains the core contracts, Node NWC adapter, Express,
  Fetch-style, raw Node, and Next.js route bridges, browser helpers, provider
  data, testkit, elements, and React packages.
- `examples/hello-fruit/server/` contains the Express + React, static HTML
  + small API, and Next.js fullstack Hello Fruit demos.
- `demos/deploy/` contains public-safe hosted demo deployment templates.
- `tools/` holds validation, conformance, package-smoke, docs, mock-wallet, and
  live-wallet smoke helpers.

## Run A Demo

The dockerized Hello Fruit demos serve a checkout UI where you can buy a fruit
sticker. Pick a stack:

```sh
npm run demo node      # Express + React          http://localhost:3000
npm run demo static    # Static HTML + small API   http://localhost:3001
npm run demo nextjs    # Next.js fullstack         http://localhost:3002
npm run demo rails     # Rails + Hotwire skeleton  http://localhost:3003
```

Each command creates a root `.env` if missing, validates `OPENRECEIVE_NWC`, and
then runs that demo's Docker Compose stack with local port publishing. The JS
demo stacks start a local Postgres container, wait for it to become healthy,
run the package-owned OpenReceive invoice migration, and record the OpenReceive
schema version before store queries. The JS local overrides run Vite or Next.js
development servers inside Docker so browser errors stay readable. The Rails
Hotwire demo is experimental skeleton work; its container runs
`rails db:prepare` for its SQLite-backed ActiveRecord store before booting.
Buying fruit creates a live Lightning invoice through your own wallet, so set a
valid receive-only `OPENRECEIVE_NWC` string (for example from Rizful or Alby
Hub) in `.env` before starting a demo. Demos refuse to boot when
`OPENRECEIVE_NWC` is missing or malformed.
The JS demos quote each fruit's USD price through live BTC/USD price providers
before creating the invoice.

Extra arguments after `--` are forwarded to `docker compose up`, for example to
run detached: `npm run demo node -- -d`.

## Current Status

This repository has the v0.1 JS reference path in place. The current gate keeps
schemas, vectors, generated contracts, package artifacts, demos, secret scans,
release metadata, deployment templates, and docs aligned before broader SDK
work proceeds.

Run the full local gate:

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

Start the deterministic, non-payable mock wallet for conformance testing:

```sh
npm run mock-wallet
```

Run the live-wallet smoke harness:

```sh
npm run test:live:nwc
```

The live smoke command skips when `OPENRECEIVE_NWC` is absent. For a trusted
local wallet profile, pass `OPENRECEIVE_ENV_FILE` pointing at a gitignored env
file.

## Product Boundary

OpenReceive creates one Lightning invoice and can show payer-side route
guidance for wallets, exchanges, swap services, fiat onramps, cards, bank
accounts, Bitcoin, or stablecoins that may be able to reach that invoice.
Provider routes are suggestions, not payment guarantees. The payer chooses and
uses third-party services outside OpenReceive.

Browser, mobile, and static frontend code never receive NWC secrets. Live
checkout always needs a backend component controlled by your application.

## Docs

Developer docs start at `docs/guides/README.md` and are indexed by
`docs/manifest.json`.

- `docs/guides/quickstart-node.md` is the current working backend quickstart.
- `docs/guides/frontend-checkout.md` covers browser helpers and UI packages.
- `docs/guides/deployment-and-recovery.md` explains host setup and optional
  one-shot poll scheduling.
- `docs/internal/README.md` is the contributor entry point for architecture,
  conformance, release, package ownership, and ADR docs.
