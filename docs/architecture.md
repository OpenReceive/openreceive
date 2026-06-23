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

## Wire Contracts

The HTTP and event contracts live under `spec/`. If a wire payload or error
shape changes, update the matching schema, vectors, generated models, and tests
in the same change.
