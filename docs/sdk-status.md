# SDK Status

This page tracks what exists in the repository, not what has been published to a
package registry.

| Package | Status | Notes |
| --- | --- | --- |
| `@openreceive/core` | Implemented | Shared errors, rates, NWC helpers, KV storage contract, pure invoice transitions, gated lookup, bounded sweep, and settlement-action lease helpers. |
| `@openreceive/node` | Implemented | `createOpenReceive()` with object methods for Express, Fetch, and raw Node; receive-checkout NWC client; package-owned Postgres/SQLite stores; local SQLite resolver; three-hook authorization; CSRF/CORS hooks; idempotent create/refresh; gated lookup; protected poll; `onPaid`; and the `openreceive` CLI. |
| `@openreceive/next` | Empty public surface | Next.js App Router routes call `openreceive.handleFetch(request)` from `@openreceive/node`; no Next-specific app-facing export is required. |
| `@openreceive/browser` | Implemented | Small app-facing entry with `createInvoice`, `status`, QR/copy/open-wallet helpers, and `createCheckoutController`; framework-adapter internals live under `@openreceive/browser/internal`. |
| `@openreceive/provider-data` | Implemented | Read-only helpers around the runtime v4 provider registry with local provider icon paths and provider-route vector coverage. |
| `@openreceive/testkit` | Implemented | Deterministic receive-client fixtures and conformance helpers. |
| `@openreceive/elements` | Implemented | No-framework checkout and theme-toggle web components for display-safe invoice data, public `status`, waiting state, countdown, copy feedback, payment wizard, lookup polling, and optional redacted browser action logging. |
| `@openreceive/react` | Implemented | `Checkout`, `useCheckout`, `CheckoutProvider`, `ThemeScope`, primitives, slots, default checkout UI, payment wizard, lookup polling, refresh/retry/cancel actions, copy feedback, and optional redacted browser action logging. |
| `@openreceive/vue` | Initial adapter | Thin typed bindings for the shared checkout web component, a packaged `checkout.vue` wrapper, styles wrapper, checkout shell, framework-named component/controller creators, theme toggle, and storage-backed theme helpers. |
| `@openreceive/svelte` | Initial adapter | Thin typed bindings for the shared checkout web component, a packaged `checkout.svelte` wrapper, styles wrapper, checkout shell, framework-named component/controller creators, theme toggle, and storage-backed theme helpers. |
| `@openreceive/angular` | Initial adapter | Thin typed bindings for the shared checkout web component, a packaged standalone checkout component module, styles wrapper, checkout shell, framework-named component/controller creators, theme toggle, and storage-backed theme helpers. |
| `openreceive` Ruby | Initial core helpers | Vector-backed exact fiat quoting, settlement detection, NWC URI parse/redaction, receive-only NIP-47 request mapping, polling/idempotency helpers, an in-memory test store, a fail-closed unavailable-wallet client, a receive-only `nwc-ruby` wrapper, and optional live smoke. |
| `openreceive-rails` Ruby | Initial adapter helpers | Production fail-closed configuration, idempotent invoice creation, authorized lookup, package-owned SQLite invoice store resolver, doctor diagnostics, backend settlement checks, route-triggered recovery sweep, duplicate-safe settlement action tracking, controller templates, Hotwire partial, install generator skeleton, optional protected poll route, and mounted engine routes. |

## Demos

| Demo | Status | Notes |
| --- | --- | --- |
| Express + React Hello Fruit | Implemented | Express mounts `openreceive.mountExpress(app)` and the React client uses `createInvoice` plus `<Checkout invoice={invoice}>`. |
| Static HTML + Small API Hello Fruit | Implemented | Web component checkout with a small Express API; checkout UI/state delegates to `@openreceive/elements`. |
| Next.js Fullstack Hello Fruit | Implemented | The App Router catch-all calls `openreceive.handleFetch(request)` and the React client uses the simplified browser/React surface. |
| Rails Hotwire Hello Fruit | Initial skeleton | Rails app skeleton with OpenReceive engine mount, package-owned SQLite invoice storage, Hotwire partial, jobs, Docker/compose templates, fail-closed no-wallet boot behavior, root demo launcher target, and container-validator coverage. |
| Rails React Hello Fruit | Quarantined | Parked until the Rails proof is green; still covered by container and storage-boundary validation but must not be treated as an active demo. |

Non-JS SDK work has started with the Ruby core-helper package after the JS
reference path and conformance gate. Future SDKs must consume shared vectors
and must not expose NWC secrets to browser or mobile runtime code.

## Current Gate

Run:

```sh
npm run test:ci
```

The current gate covers schemas, vectors, source secret scanning, TypeScript
typecheck, JavaScript tests, Ruby core and Rails adapter tests, local package
artifact imports, demo builds, generated client-bundle scanning, docs build, and
optional live NWC smoke.

## Tooling

`tools/mock-wallet` is implemented as a deterministic, non-payable local wallet
service for conformance tests. Start it with `npm run mock-wallet`; use live
wallet profile tests when proving real wallet compatibility.
