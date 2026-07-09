# Changelog

## 0.1.1 - Unreleased

### Route-shipping re-architecture (ship the routes, host keeps auth)

- OpenReceive now **ships HTTP routes** (rodauth-style) instead of leaving every host to
  hand-write them. The canonical route contract lives in `spec/openapi/openreceive-http.v1.yaml`
  (promoted from shared shapes to full paths) and is implemented identically by the Node
  adapters and the Ruby engine.
- Added the framework-agnostic `@openreceive/http` handler `(Request) => Promise<Response>`
  with three security tiers, an `authorize` hook, per-order capability tokens, a `resolveAmount`
  amount-authority hook, and error→status mapping. Thin adapters: `@openreceive/express`,
  `@openreceive/fastify`, `@openreceive/next`.
- **Capability tokens (PART 2):** checkout creation mints a high-entropy per-order token
  returned once as `order_access_token`; only its sha256 hash is stored (in the meta KV for the
  KV stores; as `order_access_token_hash` in the normalized schema via migration 002). Tier-2
  reads present it as `Authorization: Bearer` / `X-OpenReceive-Order-Token`.
- **Amount authority:** the create-checkout route never trusts a client-supplied price; the host
  `resolveAmount` hook returns the authoritative amount.
- `@openreceive/node`: added `createOrderAccessTokenManager`, `hashOrderAccessToken`, the
  `resolveAmount` types, migration 002 (both dialects), and a `migrate` note that capability
  tokens are provisioned via the meta KV.
- `@openreceive/browser`: `postOpenReceiveJson` now forwards custom headers so swap
  start/quote/refund reads can carry the order capability token (no wire break).
- **Full Ruby port:** new `openreceive-server` gem (Service, ActiveRecord + in-memory stores,
  config loader, Rack app, capability tokens) reusing the existing `openreceive` core, with NWC
  transport via the `nwc-ruby` gem; new `openreceive-rails` mountable engine (controllers inheriting
  the host `parent_controller`, `OpenReceive.configure`, an `OpenReceive::Authorization` concern,
  fail-closed Tier 3, `openreceive:install` generator, migrations). The Lightning/checkout/token/
  settlement path is fully implemented and vector-conformant in both languages; swaps and live price
  feeds are scaffolded (`NotImplementedError`) with the Node engine as the reference. The
  ActiveRecord store and Rails engine are structure-complete and unit-tested but not yet
  integration-tested against a live database / Rails app.
- **Conformance:** added cross-language vectors `idempotency-canonical-json.crosslang.json` and
  `capability-token.json` (verified JS and Ruby produce byte-identical hashes) plus HTTP golden
  vectors under `spec/test-vectors/http-golden/`.
- **Zero-config developer experience:** the host mounts the router and drops in a self-contained
  component — no payment routes and no token handling. `<Checkout orderId prefix />` (React, Vue,
  Svelte, Angular, and the `<openreceive-checkout>` element) creates the checkout against the
  mounted routes, polls status, and drives swaps itself. The browser client stores the per-order
  token and auto-attaches it (by `order_id`) on every read/swap; the create route also sets it as
  an httpOnly, path-scoped cookie so same-origin browsers authorize with no client code. Authorize
  presets `guestCheckout()` / `withUser()` (JS) and `Server::Presets.guest_checkout` / `.with_user`
  (Ruby) cover the two dominant host shapes in one line; components default the mount `prefix` to
  `/openreceive`. All three Hello Fruit demos now mount the router with `guestCheckout()` and use the
  self-contained component (their hand-written invoice/status routes are removed).
- See `docs/internal/adr/ADR-0008-route-shipping-decisions.md` for the resolved design decisions.

### Foundation

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
  initializes storage, defaults to live cached price data, auto-loads configured
  swap providers from `OPENRECEIVE_SWAP_*` env variables, and exposes service
  methods. Host apps own route protection, settlement uses backend
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
