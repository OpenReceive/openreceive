# SDK Status

This page tracks what exists in the repository, not what has been published to a
package registry.

| Package | Status | Notes |
| --- | --- | --- |
| `@openreceive/core` | Implemented | Shared errors, rates, NWC helpers, KV storage contract, pure invoice transitions, gated lookup, bounded sweep, and settlement-action lease helpers. |
| `@openreceive/node` | Implemented | Receive-checkout adapter around `@getalby/sdk` NWC, package-owned Postgres/SQLite KV stores, `OPENRECEIVE_STORE` resolver, and `openreceive` CLI for init/doctor/migrate/poll --once. |
| `@openreceive/express` | Implemented | Mounted Express routes, generic Fetch and raw Node bridges, auth/CSRF hooks, idempotent create/refresh, gated lookup, protected poll, settlement action hook, production fail-closed checks for memory storage, and static rates/routes/providers helpers. |
| `@openreceive/next` | Implemented | Next.js/App Router wrapper around the shared Fetch bridge, including catch-all route dispatch and no-wallet fail-closed responses. |
| `@openreceive/browser` | Implemented | Display-safe QR/copy/open-wallet helpers, checkout display and status models, polling watcher/controller, lookup and refresh fetchers, custom-element attribute/listener helpers, theme helpers, payment wizard state, shared labels/assets, and redacted browser logging hooks. |
| `@openreceive/provider-data` | Implemented | Read-only helpers around the runtime v4 provider registry with local provider icon paths and provider-route vector coverage. |
| `@openreceive/testkit` | Implemented | Deterministic receive-client fixtures and conformance helpers. |
| `@openreceive/elements` | Implemented | No-framework checkout and theme-toggle web components for display-safe invoice data, waiting state, countdown, copy feedback, payment wizard, lookupUrl polling, and optional redacted browser action logging. |
| `@openreceive/react` | Implemented | Hook, provider/context, theme scope/toggle, primitives, slots, default checkout UI, payment wizard, lookupUrl polling, refresh/retry/cancel actions, copy feedback, and optional redacted browser action logging. |
| `@openreceive/vue` | Initial adapter | Thin typed bindings for the shared checkout web component, a packaged `checkout.vue` wrapper, browser-owned light/dark CSS wrapper export, full checkout shell, framework-named shell/component/controller creators, theme toggle, and storage-backed theme helpers, with package-owned attributes/listeners. |
| `@openreceive/svelte` | Initial adapter | Thin typed bindings for the shared checkout web component, a packaged `checkout.svelte` wrapper, browser-owned light/dark CSS wrapper export, full checkout shell, framework-named shell/component/controller creators, theme toggle, and storage-backed theme helpers, with package-owned attributes/listeners. |
| `@openreceive/angular` | Initial adapter | Thin typed bindings for the shared checkout web component, a packaged standalone checkout component module, browser-owned light/dark CSS wrapper export, full checkout shell, framework-named shell/component/controller creators, theme toggle, and storage-backed theme helpers, with package-owned attributes/listeners. |
| `openreceive` Ruby | Initial core helpers | Vector-backed exact fiat quoting, settlement detection, NWC URI parse/redaction, receive-only NIP-47 request mapping, polling/idempotency helpers, an in-memory test store, a fail-closed unavailable-wallet client, a receive-only `nwc-ruby` wrapper, and an optional Ruby live smoke with opt-in invoice creation. CI skips wallet calls when `nwc-ruby` is unavailable. |
| `openreceive-rails` Ruby | Initial adapter helpers | Production fail-closed configuration, idempotent invoice creation, authorized lookup, package-owned SQLite invoice store resolver, doctor diagnostics, backend settlement checks, duplicate-safe settlement action tracking, controller templates, Hotwire partial, install generator skeleton, protected poll route, and mounted engine routes around an injected receive-only client with `503 WALLET_UNAVAILABLE` handling. Full Rails smoke/live proof is still pending. |

## Demos

| Demo | Status | Notes |
| --- | --- | --- |
| Express + React Hello Fruit | Implemented | Express route adapter with a thin React client that delegates checkout UI/state to `@openreceive/react`. |
| Static HTML + Small API Hello Fruit | Implemented | Web component checkout with a small Express API; checkout UI/state delegates to `@openreceive/elements`. |
| Next.js Fullstack Hello Fruit | Implemented | One App Router catch-all route delegates request/response glue to `@openreceive/next`, with a thin React client that delegates checkout UI/state to `@openreceive/react`. |
| Rails Hotwire Hello Fruit | Initial skeleton | Rails app skeleton with OpenReceive engine mount, package-owned SQLite invoice storage, Hotwire partial, jobs, Docker/compose templates, fail-closed no-wallet boot behavior, root demo launcher target, and container-validator coverage. Bundle/build smoke is still pending. |
| Rails React Hello Fruit | Quarantined | Parked until the Rails proof is green; still covered by container and storage-boundary validation but must not be treated as an active demo. |

Non-JS SDK work has started with the Ruby core-helper package after the JS
reference path and conformance gate. Future SDKs must consume shared vectors
and must not expose NWC secrets to browser or mobile runtime code.

Frontend framework adapters for Vue, Svelte, and Angular are currently thin
bindings around `<openreceive-checkout>`. They re-export shared browser checkout
attributes/listeners/element creators, theme-toggle element bindings, and
storage-backed theme/toggle/attribute/control helpers so apps do not copy event
names, attribute names, theme keys, toggle labels, or light/dark behavior. They
also expose framework-local `styles.css` wrappers around
`@openreceive/browser/styles.css` so apps can import default checkout CSS from
the package they install while keeping the CSS owned once. `@openreceive/elements`
exposes the same wrapper for no-framework apps. Each adapter also exposes a
one-call checkout-shell binding that returns root theme attributes, checkout
binding, and theme-toggle binding from the shared browser model, plus a
component-shaped model that bundles those shell bindings with the shared
custom-element registration hook. The packages also ship framework component
entry files that wrap the same shared web component rather than forking
checkout behavior. Framework-named checkout controller helpers delegate to the
browser-owned watcher/copy/open-wallet/reload/retry/refresh/cancel controller so app
integrations can use headless actions without copying lifecycle behavior.

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
