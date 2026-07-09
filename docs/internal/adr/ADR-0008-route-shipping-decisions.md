# ADR 0001 — Route-Shipping Re-Architecture Decisions

Status: accepted (2026-07-08)
Context: implements `zz-switch-to-vanilla-http.txt` (OpenReceive re-architecture — ship
rodauth-style HTTP routes for Node + full Ruby port). PART 12 of that spec lists open
decisions the implementer must surface rather than silently guess. They are resolved here.

## Decisions

1. **Capability token storage — column on `openreceive_invoices`.**
   Migration 002 adds `order_access_token_hash TEXT` (nullable, set on first checkout per
   order) plus an index on `(order_id, order_access_token_hash)`. No separate table.
   Rationale: single token per order; simplest join-free reads. Spec default.

2. **Ruby gem split — three gems.**
   `openreceive` (core, already exists, dependency-free) + `openreceive-server`
   (Service, ActiveRecord store, NWC transport, pricing, swaps, config loader, Rack app)
   + `openreceive-rails` (engine, controllers, generators, migrations; depends on the
   other two). Non-Rails hosts pull only core+server. Spec default.

3. **Swap route tier — Tier 2 (owner capability token).**
   `swap.options`, `swap.quote`, `swap.start`, `swap.refund` require a valid per-order
   capability token (refund additionally requires the refund nonce). Enables anonymous
   self-service swaps on sites without accounts. Spec default.

4. **Minimum Rails version — dynamic superclass, floor 7.1.**
   Generated migrations use `ActiveRecord::Migration[<current_version>]` resolved at
   generate time; `openreceive-rails.gemspec` requires `rails >= 7.1`.

5. **Ruby NWC transport — adopt the `nwc-ruby` gem** (per the cover note in the spec file).
   `NwcRubyReceiveClient` already wraps an injected duck-typed client; we inject a real
   `nwc-ruby` client (receive-only: only `make_invoice` + `list_transactions` reachable).
   Source: https://github.com/MegalithicBTC/nwc-ruby

6. **Rails `parent_controller` default — `ActionController::Base`** (host sets
   `ApplicationController`). Engine controllers inherit host CSRF/auth/current_user.
   Spec default.

7. **`openreceive_for` routing DSL — deferred.** Hosts use
   `mount OpenReceive::Engine => "/openreceive"` for now.

## Token storage — reconciling "column" with the live architecture

The live JS KV stores (`postgres-store.ts`, `sqlite-store.ts`) do **not** use the normalized
`migrations/001_*.sql` table; they use a 10-column JSON *envelope*
(`invoice_id, rev, payment_hash, bolt11, idempotency_scope, order_id, checkout_id, terminal,
expires_at, data`) plus an `openreceive_meta` KV table with `getMeta`/`casMeta`. The normalized
migration file is orphaned at runtime (only Rails/normalized hosts would use it).

Resolution that honors the "single token per order, no extra table" intent without schema surgery:

- **KV stores (JS postgres/sqlite, Ruby in-memory + durable):** store the per-order token hash in
  the existing **meta KV** under key `order_access_token:<orderId>`. Write-once minting comes free
  from `casMeta(key, hash, null)` (insert-if-absent → conflict on replay). No new column, both
  backends' DDL stay identical.
- **Normalized / Rails schema:** migration `002_add_order_access_token.{postgres,sqlite}.sql` adds
  the `order_access_token_hash` column + index to the normalized `openreceive_invoices` (this is the
  literal "column on invoices" choice, for the canonical SQL Rails copies).
- Token **hashing is identical** everywhere (`sha256:<hex>` of the raw token), so the cross-language
  capability-token vector passes regardless of where the hash is physically stored.

## DX follow-ups (accepted) — "the developer never thinks about routes or tokens"

8. **Self-contained checkout component.** `<Checkout orderId prefix />` (React) /
   `<openreceive-checkout order-id prefix>` (element, wrapped by Vue/Svelte/Angular) creates the
   checkout against `{prefix}/checkouts`, then polls status and drives swaps against
   `{prefix}/orders/{orderId}`. The developer passes only an order id; the `checkout`-prop mode
   stays for hosts that create server-side.
9. **Invisible capability token.** The browser client stores the per-order `order_access_token`
   from creation (`internal/order-token.ts`) and auto-attaches it, keyed by `order_id`, on every
   status poll and swap call. No token handling in app code.
10. **Cookie auth for same-origin web (#4).** The create route also sets the token as an httpOnly,
    `SameSite=Lax`, path-scoped (`{prefix}/orders/{orderId}`) cookie `openreceive_order_token`
    (`Secure` over https); reads accept the cookie **or** the bearer header. Byte-identical in Node
    and Ruby.
11. **Authorize presets (#5).** `guestCheckout({ allowSweep? })` and
    `withUser(getUser, { ownsOrder?, isAdmin? })` — one-line policies for the two dominant host
    shapes, built on a precomputed `tokenValid` field in the authorize context. Mirrored as
    `Server::Presets.guest_checkout` / `.with_user` in Ruby.
12. **Default mount prefix (#6).** Components default `prefix` to `/openreceive` and derive the
    order URL from it, so mounting at the default needs no `orderUrl`/`prefix` wiring.

## Notes carried from ground-truth mapping

- There is no `CheckoutSnapshot` schema; the canonical checkout shape is
  `components.schemas.Checkout` in `spec/openapi/openreceive-http.v1.yaml`. The route
  layer returns that shape.
- The error `code` enum lives in `spec/schemas/error.schema.json` (17 values incl.
  `UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `WALLET_UNAVAILABLE`,
  `INVALID_REQUEST`, `INVOICE_EXPIRED`, `TIMEOUT`, `INTERNAL`).
- Ruby `InMemoryInvoiceKvStore` method names are idiomatic (`put_invoice_record`,
  `find_by_invoice_id`, `cas_meta`, `mark_*`); the durable store mirrors that API and
  adds the missing `list_by_order_id` / `list_by_checkout_id` / `list_open` /
  `ensure_schema` needed for reconcile + reads.
