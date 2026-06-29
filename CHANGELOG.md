# Changelog

## 0.1.1 - Unreleased

- Initialized the v0.1 contract-first repository foundation.
- Added governance, security, contribution, and agent operating rules.
- Added initial schemas, data files, validation tools, and test vectors.
- Added JS core, Node NWC receive service, browser helpers, provider-data,
  testkit, elements, and React packages.
- Added Hello Fruit Express, static HTML + small API, and Next.js fullstack
  demos.
- Added demo deployment templates, public demo deployment docs, and hosted-demo
  metadata/smoke checks.
- Added OpenAPI, AsyncAPI, generated contract constants, package artifact smoke,
  demo build, docs build, client-bundle secret scan, and live NWC smoke gates.
- Prepared the frontend package family for public packaging with publishable
  browser/provider-data/UI adapter manifests and declaration-emitting package
  artifacts.
- Added read-only GitHub workflow skeletons, disabled publish workflow, and
  workflow safety validation.
- Added idempotency, settlement action, rate, provider-route, route-boundary,
  and security regression coverage.
- Kept deterministic internal testkit coverage for non-payable conformance
  fixtures without shipping a public mock-wallet path.
- Added OpenReceive Node Postgres pool setup for Hello Fruit demos and removed
  the unfinished Rails adapter/demo lane before release.
- Simplified the app-facing API before release: `createOpenReceive()` now
  reads `OPENRECEIVE_NWC`, validates receive-only wallet access at boot,
  initializes storage, defaults to live cached price data, and exposes
  service methods. Host apps own route protection, settlement uses backend
  settlement hooks, browser checkout creation uses `requestCheckout`, Node
  checkout creation uses `orderId`, `idempotencyKey`, nested `amount`,
  `memo`, and `expiresInSeconds`, and app routes call those service methods
  from app-owned controllers. Added `openreceive` plus public
  `@openreceive/core` and `@openreceive/node` package surfaces while keeping
  `@openreceive/testkit` private. Removed Node `init`, built-in
  auth/CSRF/CORS/cron hooks, public provider and
  route catalog endpoints, the old mount functions, Next dispatcher, legacy
  framework bridges, long browser/React names, and public
  workflow-state element attribute rather than keeping compatibility aliases.
