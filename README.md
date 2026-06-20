# OpenReceive

OpenReceive is an open source receive-payments kit for apps that want to
create one Bitcoin Lightning BOLT11 invoice, show payer-side route suggestions,
and unlock fulfillment only after backend-verified settlement.

OpenReceive is not a bank, exchange, wallet, broker, custodian, or payment
processor. It does not transmit money or hold customer funds. A merchant brings
their own server-side Nostr Wallet Connect (NWC / NIP-47) connection to a wallet
they control, and OpenReceive helps the merchant backend create and verify
receive-only invoices.

The v0.1 reference path is contract-first and server-owned:

- `spec/` is the source of truth for schemas, shared data, and test vectors.
- `packages/js/` contains the core contracts, Node NWC adapter, Express routes,
  browser helpers, provider data, testkit, elements, and React packages.
- `examples/hello-fruit/server/` contains the Express + React and static HTML
  + small API Hello Fruit demos.
- `demos/deploy/` contains public-safe hosted demo deployment templates.
- `tools/` holds validation, conformance, package-smoke, docs, mock-wallet, and
  live-wallet smoke helpers.

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
suggestions for wallets, exchanges, swap services, or fiat onramps that may be
able to pay that invoice. Provider routes are suggestions, not payment
guarantees. The payer chooses and uses third-party services outside
OpenReceive.

Browser, mobile, and static frontend code never receive NWC secrets. Live
checkout always needs a merchant-controlled backend component.

## Docs

Public docs live in `docs/` and are indexed by `docs/manifest.json`.

- `docs/01-quickstart-node.md` is the current working backend quickstart.
- `docs/11-conformance.md` covers shared vectors, mock wallet, and live wallet
  smoke expectations.
- `docs/13-demo-deployment.md` covers the separate demo edge and deployment
  boundary.
- `docs/sdk-status.md` tracks implemented packages versus planned SDKs.
