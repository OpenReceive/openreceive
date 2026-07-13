# Architecture Notes

This document is for contributors and adapter authors. Getting-started docs keep
to the app-facing API.

## Settlement Authority

OpenReceive treats backend status refresh as the settlement authority. Wallet
events and frontend callbacks are not settlement proof. A payment is settled
only when a server-side NWC `list_transactions` result contains `settled_at` or
a settled transaction state.

## Store Coordination

The durable OpenReceive store is the only cross-process coordination point.
Invoice rows keep lifecycle fields such as `transaction_state`,
`workflow_state`, `settlement_action_state`, timestamps, leases, and scan
metadata so multiple web processes can safely create, refresh status, and
complete settlement actions without a daemon.

Route-triggered status refresh uses a durable global scan gate and per-window
pagination cursor. Each request performs at most one bounded wallet page, then
returns stored state.

Settlement actions are claimed through the store and are at least once. App
hooks must deduplicate by `payment_hash`, invoice id, or the app's own order
id.

OpenReceive does not add a wallet event listener, webhook bridge, SSE bus, or
in-memory event bus because those would become a second coordination path.
Frontend status checks only ask the backend to refresh; the store plus backend
status refresh remain the settlement authority.

## NWC Client Strategy

OpenReceive depends on Nostr Wallet Connect, but the receive-checkout API is
not a raw NWC proxy. The JavaScript path wraps the wallet client behind a
receive-only interface that exposes `get_info`, `make_invoice`, and
`list_transactions` behavior plus safe diagnostics. OpenReceive checkout APIs do
not expose send-payment methods.

Every NWC client or adapter needs URI parsing and redaction, capability
preflight, NIP-04 compatibility, NIP-44 v2 support where practical, request and
response event shape tests, settlement normalization, error normalization,
metadata size enforcement, and live wallet smoke tests that skip without
`OPENRECEIVE_NWC`.

Crypto dependencies must be documented before an SDK is published. Do not
claim edge, serverless, or mobile-secret support until the crypto and refresh
constraints are proven in that runtime.

## Package Surfaces

App code should use:

- `@openreceive/node` for `createOpenReceive()`.
- `@openreceive/browser` for the small browser helper allow-list.
- `@openreceive/react`, `@openreceive/elements`, or framework bindings for UI.

Framework adapters share labels, icons, theme helpers, custom-element contracts,
display models, watcher/controller code, and event constructors from
`@openreceive/browser/internal`. Keeping those internals in one package keeps
React, web components, Vue, Svelte, Angular, and demos aligned without making
every helper app-facing.

The internal browser subpath is for OpenReceive packages and adapter authors.
App developers should import from `@openreceive/browser`, `@openreceive/react`,
or `@openreceive/elements`.

## Provider Data

The canonical v0.1 registry lives in
`packages/js/provider-data/src/data/openreceive-providers.v4.json`. It is the
source used by the JavaScript runtime package, docs validation,
provider-route vectors, and payment-wizard suggestions.

`npm run validate` checks the registry version, counts, provider references,
route references, local icon/tutorial paths, duplicate route or country ids,
duplicate provider refs inside routes, and ranked route order. Provider claims
require evidence URLs or conservative caveats. Do not add new claims by editing
package code; update the canonical registry and validation in the same change.

## Price feed cache

`createOpenReceive()` defaults to a live cached price feed. It reads rates from
two hard-coded Simple Price endpoints — a primary and a fallback — only when a
fiat quote is actually needed, then caches the result in the OpenReceive
database. Internal tests and deterministic fixtures can pass an explicit
`StaticPriceProvider`.

Both endpoints return Simple Price compatible JSON (`bitcoin.usd`, …). Numbers
and decimal strings are accepted; OpenReceive converts the selected BTC fiat
price to a decimal string before final quote math and does not use binary
floating point for fiat-to-sat conversion.

On each demanded rate read:

1. **Read the cache.** If the stored rate map is younger than **60 seconds**,
   use it and skip the network.
2. **Claim the refresh in the database.** If stale/missing, write a short
   refresh marker so other processes do not also call providers.
3. **Refresh from the primary URL** (5s timeout), then the **fallback** if
   needed.
4. **Write the cache** (or record failure for the same 60s window so retries
   fail fast).

Override URLs with `OPENRECEIVE_PRICE_FEED_PRIMARY_URL` /
`OPENRECEIVE_PRICE_FEED_FALLBACK_URL`. The cache row key is
`price_feed:bitcoin` in the store meta table. Source order:
`static_mock` → `primary` → `fallback`. Canonical constants live in
`spec/data/rates/price-sources.json`.

Direct BTC / SAT / SATS checkouts never call a price provider. Quote rules and
`amount_msats` contract: [ADR-0004](adr/ADR-0004-amount-msats-and-fiat-quote-contract.md).
App-facing wiring: [Price Feeds](../guides/price-feeds.md).

`@openreceive/node` also exposes `createOpenReceivePriceFeed({ store, currencies })`
for custom runtimes. Most apps should let `createOpenReceive()` do this.
`@openreceive/core` exposes lower-level pieces (`createCachedLivePriceFeed`,
`createLivePriceFeedProviders`, `getBtcFiatRatesWithFallback`).

## Wire Contracts

The HTTP and event contracts live under `spec/`. If a wire payload or error
shape changes, update the matching schema, vectors, generated models, and tests
in the same change.
