# Changelog

## 0.1.0 - Unreleased

- Initialized the v0.1 contract-first repository foundation.
- Added governance, security, contribution, and agent operating rules.
- Added initial schemas, data files, validation tools, and test vectors.
- Added JS core, Node NWC receive service, browser helpers, provider-data,
  testkit, elements, and React packages.
- Added Hello Fruit Express + React, static HTML + small API, and Next.js
  fullstack demos.
- Added demo deployment templates, public demo deployment docs, and hosted-demo
  metadata/smoke checks.
- Added OpenAPI, AsyncAPI, generated contract constants, package artifact smoke,
  demo build, docs build, client-bundle secret scan, and live NWC smoke gates.
- Added read-only GitHub workflow skeletons, disabled publish workflow, and
  workflow safety validation.
- Added idempotency, settlement action, rate, provider-route, route-boundary,
  and security regression coverage.
- Added deterministic mock wallet tooling for non-payable conformance fixtures.
- Added package-owned Node Postgres pool setup for Hello Fruit demos and
  quarantined the copied Rails React skeleton until the Rails proof is green.
- Simplified the app-facing API before release: `createOpenReceive()` now
  reads `OPENRECEIVE_NWC`, validates receive-only wallet access at boot,
  initializes storage, and exposes service methods. Host apps own route
  protection, settlement uses `onPaid`, browser invoice creation uses
  `orderUuid`, `amountInSatoshis` or `fiat`, and
  `optionalInvoiceDescription`, and app routes call those service methods from
  app-owned controllers. Removed Node `init`/`doctor`, built-in
  auth/CSRF/CORS/cron hooks, public mounted poll routes, public provider and
  route catalog endpoints, the old mount functions, Next dispatcher, legacy
  framework bridges, long browser/React names, and public
  workflow-state element attribute rather than keeping compatibility aliases.
