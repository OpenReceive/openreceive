# Changelog

## 0.1.1 - Unreleased

### Hosted demos removed

- Removed `demos/deploy/` hosted-demo deployment templates, validators, and
  smoke/SEO helper routes. Hello Fruit stacks remain as local `examples/`;
  public demos live on openreceive.org outside this repository.

### Swap refund UX

- Surface FixedFloat emergency details on the public swap payload and checkout UI:
  `refund_reason` (`underpaid` / `late_deposit` / `underpaid_and_late`),
  `deposit_received_amount` (`from.tx.amount`), and `refund_amount` (`back.amount`).
  Checkout copy explains why a refund is needed and shows amount received vs required.

### Docs

- Slimmed `docs/guides/` for day-one integrators; moved swap runbooks, custom
  controller examples, settlement sweeps, deployment storage matrix, and price
  feed cache detail into `docs/internal/`. Merged secret management into
  Security, retries into the Node Quickstart, and mobile notes into Frontend
  Checkout.

### Own prepare + guest resume

- Replaced public `getCheckoutAmount` / `get_checkout_amount` with required
  `prepareCheckout` / `prepare_checkout`. POST `/prepare` is the sole price
  authority; OpenReceive persists amount (+ optional `summary`) and create-checkout
  reads that persist only.
- Added `GET /orders/{order_id}/summary` (Tier 1, public-if-exists) for guest
  resume display redraw.
- Frontend: `<Checkout orderId />` always fetches summary; opt into
  `/checkout/:orderId` History API sync with `syncUrl` (replaces the old `resume`
  boolean that bundled both). Browser helpers: `requestPrepare`,
  `requestOrderSummary`.

### Rename amount-authority hook

- Renamed `resolveOrder` / `resolve_order` → `getCheckoutAmount` / `get_checkout_amount`
  (superseded by `prepareCheckout` above).
  The hook ran only on POST create-checkout (pricing), never on GET order status.
  Deprecated JS aliases `ResolveOrder` / `GetOrderAmount` remain for one release.

### Global FixedFloat rates cache

- Display quotes and catalog min/max now come from FixedFloat's public XML rates
  export (`/rates/fixed.xml`), cached in `openreceive_meta` under
  `swap_rates:<provider>:fixed` via the same durable single-flight pattern as the
  fiat price feed and `/ccies` catalog. Default refresh is 15s. Concurrent
  checkouts share one blob — no per-user authenticated `/price`. The XML export
  is public (no weight budget), so a short TTL is safe. A failed rates refresh
  fails closed (no stale serve) so quote/catalog/start skip that provider and
  try the next entry in `swap.providers`.
- `/create` remains the binding rate. Removed the old per-asset `/price` probe
  cache (`swap_pair_limits:*`).

### Swap FixedFloat stress hardening

- Monotonic refund poll merge: `refund_pending` cannot demote to `refund_required`
  (closes double-`/emergency` on read-after-write lag / timeout rollback thrash).
- Durable store-backed per-provider weight ledger (`swap_provider_weight:<id>`)
  shared across dynos; soft-cap 200/min with create gate at 150; backoff on HTTP 429.
  Assumes FixedFloat-compatible limits for every provider. When the preferred
  entry in `swap.providers` is rate-limited, quote/start fail over to the next
  provider that still supports the pay-in asset.
- Create timeout/network → `provider_order_creation_needs_reconcile` and blocks
  auto-mint of attempt N+1 (FixedFloat has no client idempotency key).
- Shadow invoice default floor raised to `600+900+300=1800`; post-create guard if
  provider `expires_at` outlives the bolt11 → `provider_order_expires_after_shadow_invoice`.
- Operator `refreshSwap` / HTTP `refresh_swap` for `attention` +
  `provider_reported_emergency` (no unbounded auto-poll of attention).
- Bounded grace poll after top-level `expired` until `provider_expires_at + 900s`
  (still not reusable as a deposit address).
- `/ccies` filters `recv`/`send`; surface `emergency_repeat`; stress docs aligned.

### API surface simplification

- Removed the snake_case `order()` dispatcher from the JS/Ruby SDKs. HTTP handlers
  call typed camelCase methods (`getOrder`, `swapOptions`, `swapQuote`, `startSwap`,
  `refundSwap`) directly; OpenAPI wire stays snake_case.
- `SwapOption` / `PublicSwap` / `SwapAttempt` are camelCase end-to-end in the JS SDK
  (`payInAsset`, `depositAddress`, `attemptId`, …). HTTP serialization maps at the
  boundary via `toHttpSwapOption` / `toHttpPublicSwap`.
- Trusted create-checkout amount is one shape only: `{ amount: { sats } }` or
  `{ amount: { currency, value } }`. Top-level `usd`/`sats` and nested
  `amount.btc`/`amount.fiat` are rejected in Node, browser `requestCheckout`, and Ruby.
- Deleted dead browser asset copies (`pay_tutorials`, `provider-icons`), Claude project
  memory, and FixedFloat scrape junk. Package-smoke CSS assertion updated for daisyUI.
  `engines.node` aligned to `>=22` with `.nvmrc`.

### Swap stress-test audit logging

- Server: `swap.state.changed`, `swap.attention.raised`, `swap.refund.rejected`,
  `swap.refund.nonce_issued`, and `swap.refund.provider_failed` for poll-driven
  transitions, settlement-attention flips, and refund abuse (stale nonce, address
  mismatch, double-confirm, wrong state). Refund addresses and nonces stay out of
  logs (`refund_nonce_present` only).
- Browser: status polls emit `checkout.state.refreshed` + `swap.state.changed` (with
  `wallet_settled` / UI label); swap start/refund HTTP emits `swap.start.*` /
  `swap.refund.*`. Checkout swap snapshots now carry `attention_reason` and
  `refund_nonce_expires_at` for client-side audit.
- Docs: `docs/guides/automated-swaps.md` → "Auditing Swap Stress Tests".

### Route-shipping re-architecture (ship the routes, host keeps auth)

- OpenReceive now **ships HTTP routes** (rodauth-style) instead of leaving every host to
  hand-write them. The canonical route contract lives in `spec/openapi/openreceive-http.v1.yaml`
  (promoted from shared shapes to full paths) and is implemented identically by the Node
  adapters and the Ruby engine.
- Added the framework-agnostic `@openreceive/http` handler `(Request) => Promise<Response>`
  with three security tiers, an `authorize` hook, per-order capability tokens, a `resolveOrder`
  amount-authority hook, and error→status mapping. Thin adapters: `@openreceive/express`,
  `@openreceive/fastify`, `@openreceive/next`.
- **Capability tokens (PART 2):** checkout creation mints a high-entropy per-order token
  returned once as `order_access_token`; only its sha256 hash is stored (in the meta KV for the
  KV stores; as `order_access_token_hash` in the normalized schema via migration 002). Tier-2
  reads present it as `Authorization: Bearer` / `X-OpenReceive-Order-Token`.
- **Amount authority:** the create-checkout route never trusts a client-supplied price.
  `resolveOrder` / `resolve_order` is **required** at handler construction (omitting it throws);
  client `amount` / `sats` / `usd` on the create body are rejected with 400; `null` → 404.
  The low-level `getOrCreateCheckout` service method still accepts an explicit amount for
  trusted / testing entry points. Umbrella subpaths: `openreceive/express|fastify|next`.
  Opt-in `startSweeper({ intervalMs })` for idle long-lived processes (not an adapter default).
- `@openreceive/node`: added `createOrderAccessTokenManager`, `hashOrderAccessToken`, the
  `resolveOrder` types, `startSweeper`, migration 002 (both dialects), and a `migrate` note that
  capability tokens are provisioned via the meta KV.
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
  checkout creation uses `orderId` plus `usd`/`sats`/`amount`, `memo`,
  `descriptionHash`, and `metadata`, and app routes call those service methods
  from app-owned controllers. Added `openreceive` plus public
  `@openreceive/core` and `@openreceive/node` package surfaces while keeping
  `@openreceive/testkit` private. Removed Node `init`, built-in
  auth/CSRF/CORS/cron hooks, public provider and
  route catalog endpoints, the old mount functions, Next dispatcher, legacy
  framework bridges, long browser/React names, and public
  workflow-state element attribute rather than keeping compatibility aliases.
