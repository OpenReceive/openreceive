# Architecture Notes

This document is for contributors and adapter authors. Getting-started docs keep
to the app-facing API.

## Settlement Authority

OpenReceive treats backend wallet lookup as the settlement authority. Wallet
notifications, browser polling, and frontend callbacks are passive hints. A
payment is settled only when backend `lookup_invoice` returns `settled_at` or a
settled transaction state.

## Store Coordination

The durable OpenReceive store is the only cross-process coordination point.
Invoice rows keep lifecycle fields such as `transaction_state`,
`workflow_state`, `settlement_action_state`, timestamps, leases, and lookup
metadata so multiple web processes can safely create, refresh, look up, sweep,
and complete settlement actions without a daemon.

Route-triggered lookup and optional one-shot polling both use the same guarded
path. Per-invoice cooldown and the global lookup token bucket prevent runaway
wallet calls while still allowing recovery after missed browser activity.

Settlement actions are claimed through the store and are at least once. App
hooks must deduplicate by `payment_hash`, invoice id, or the app's own order
id.

OpenReceive does not add a notification listener, webhook bridge, SSE bus, or
in-memory event bus because those would become a second coordination path.
Wallet notifications and frontend polling stay passive; the store plus backend
lookup remain the recovery and settlement authority.

## NWC Client Strategy

OpenReceive depends on Nostr Wallet Connect, but the receive-checkout API is
not a raw NWC proxy. The JavaScript path wraps the wallet client behind a
receive-only interface that exposes `get_info`, `make_invoice`, and
`lookup_invoice` behavior plus safe diagnostics. OpenReceive checkout APIs do
not expose send-payment methods.

Every NWC client or adapter needs URI parsing and redaction, capability
preflight, NIP-04 compatibility, NIP-44 v2 support where practical, request and
response event shape tests, settlement normalization, error normalization,
metadata size enforcement, and live wallet smoke tests that skip without
`OPENRECEIVE_NWC`.

Crypto dependencies must be documented before an SDK is published. Do not
claim edge, serverless, or mobile-secret support until the crypto and polling
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

## Wire Contracts

The HTTP and event contracts live under `spec/`. If a wire payload or error
shape changes, update the matching schema, vectors, generated models, and tests
in the same change.
