# SDK Status

This page tracks what exists in the repository, not what has been published to a
package registry.

| Package | Status | Notes |
| --- | --- | --- |
| `@openreceive/core` | Implemented | Shared error codes, rates, canonical price-provider fallback helpers, settlement, polling, storage, and NWC URI helpers. |
| `@openreceive/node` | Implemented | Receive-checkout adapter around `@getalby/sdk` NWC with canonical wallet-error normalization, payment notification listener helper, package-owned Postgres and SQLite invoice persistence/migration helpers, and an `openreceive` CLI surface for init/migrate/doctor/poll/listen setup. |
| `@openreceive/express` | Implemented | Mounted HTTP routes, auth hooks, signed event URLs, idempotent create/refresh, lookup, SSE events, settlement action hook, separate settlement polling runner, payment notification runner with startup logs, production fail-closed checks for in-memory invoice storage, and static rates/routes/providers helpers. |
| `@openreceive/next` | Implemented | Fetch API bridge for Next.js/App Router route handlers that delegates to the Express adapter contract, including catch-all route dispatch, request conversion, captured responses, no-wallet fail-closed responses, default event bus setup, and package-owned SSE invoice event streams. |
| `@openreceive/browser` | Implemented | Display-safe QR, copy, open-wallet, event parsing, checkout display model, checkout status display model, display HTML escaping, and display-data-to-state helpers with settled timestamp preservation, checkout state reducer helpers, waiting/countdown display helpers, framework-neutral checkout watcher, checkout action controller with copy/open-wallet/reload/retry/refresh/cancel actions, lookup fetcher, and idempotent refresh fetcher, custom-element attribute/listener/creator helpers, custom-element attribute-name contracts, shadow-part/action selector contracts, checkout/theme attribute parsers, checkout custom-event helpers, theme-toggle element creator/helpers, theme-change event helper, full checkout-shell binding and element-creator model, payment wizard state/selection reducer/model, shared wizard DOM attributes/selectors/parsers, shared checkout data attributes/selectors, shared route/provider and route-asset display models, shared country picker/map model with display labels, viewport, optional land-path subpath, and region geometry, country/theme storage helpers, theme binding/toggle/attribute/control helpers, shared transient feedback controller, shared checkout labels/action-label helpers/defaults, shared provider-copy event helper, shared checkout icon assets/helpers, browser-owned default checkout light/dark CSS and web-component shadow styles, and redacted browser logging hooks. |
| `@openreceive/provider-data` | Implemented | Read-only helpers around the runtime v4 provider registry with local provider icon paths and provider-route vector coverage. |
| `@openreceive/testkit` | Implemented | Deterministic receive-client fixtures and conformance helpers. |
| `@openreceive/elements` | Implemented | No-framework checkout web component and theme-toggle web component for display-safe invoice data, including waiting state, countdown, browser-owned copy feedback, theme attribute, browser-owned light/dark CSS wrapper export and shadow styles, package-owned payment wizard with shared country map model, shared icons, and browser-owned wizard DOM binding contract, browser checkout controller for lookupUrl polling/SSE/copy/open-wallet wiring, stored light/dark toggle behavior, and optional redacted browser action logging. |
| `@openreceive/react` | Implemented | Hook, provider/context, theme scope/toggle, primitives, slot/component overrides, importable wrapper for browser-owned light/dark CSS, default checkout UI, waiting state, countdown, package-owned payment wizard with shared country map model and shared icons, lookupUrl polling/SSE/copy/open-wallet/reload/retry/refresh/cancel wiring through the browser checkout controller, default buttons wired to controller-backed hook actions, browser-owned transient copy feedback, and optional redacted browser action logging for display-safe invoice data. |
| `@openreceive/vue` | Initial adapter | Thin typed bindings for the shared checkout web component, a packaged `checkout.vue` wrapper, browser-owned light/dark CSS wrapper export, full checkout shell, framework-named shell/component/controller creators, theme toggle, and storage-backed theme helpers, with package-owned attributes/listeners. |
| `@openreceive/svelte` | Initial adapter | Thin typed bindings for the shared checkout web component, a packaged `checkout.svelte` wrapper, browser-owned light/dark CSS wrapper export, full checkout shell, framework-named shell/component/controller creators, theme toggle, and storage-backed theme helpers, with package-owned attributes/listeners. |
| `@openreceive/angular` | Initial adapter | Thin typed bindings for the shared checkout web component, a packaged standalone checkout component module, browser-owned light/dark CSS wrapper export, full checkout shell, framework-named shell/component/controller creators, theme toggle, and storage-backed theme helpers, with package-owned attributes/listeners. |
| `openreceive` Ruby | Initial core helpers | Vector-backed exact fiat quoting, settlement detection, NWC URI parse/redaction, receive-only NIP-47 request mapping, polling/idempotency helpers, an in-memory test store, a fail-closed unavailable-wallet client, a receive-only `nwc-ruby` wrapper, and an optional Ruby live smoke with opt-in invoice creation. CI skips wallet calls when `nwc-ruby` is unavailable. |
| `openreceive-rails` Ruby | Initial adapter helpers | Production fail-closed configuration, in-memory storage rejection for production, idempotent invoice creation, authorized lookup, worker/listener verification, doctor diagnostics, backend settlement checks, passive notification handling, duplicate-safe settlement action tracking, ActiveRecord storage templates, controller/job/channel templates, Hotwire partial, install generator skeleton, generated doctor/poll/listen tasks, and optional mounted engine routes around an injected receive-only client with `503 WALLET_UNAVAILABLE` handling. Full Rails demo smoke is still pending. |

## Demos

| Demo | Status | Notes |
| --- | --- | --- |
| Express + React Hello Fruit | Implemented | Express route adapter with a thin React client that delegates checkout UI/state to `@openreceive/react`. |
| Static HTML + Small API Hello Fruit | Implemented | Web component checkout with a small Express API; checkout UI/state delegates to `@openreceive/elements`. |
| Next.js Fullstack Hello Fruit | Implemented | One App Router catch-all route delegates request/response/SSE glue to `@openreceive/next`, with a thin React client that delegates checkout UI/state to `@openreceive/react`. |
| Rails Hotwire Hello Fruit | Initial skeleton | Rails app skeleton with OpenReceive engine mount, Hotwire partial, jobs, Docker/compose templates, fail-closed no-wallet boot behavior, root demo launcher target, and container-validator coverage. Bundle/build smoke is still pending. |
| Rails React Hello Fruit | Quarantined | Parked until the Rails proof is green; files must not be treated as an active demo. |

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
