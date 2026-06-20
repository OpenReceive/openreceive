# SDK Status

This page tracks what exists in the repository, not what has been published to a
package registry.

| Package | Status | Notes |
| --- | --- | --- |
| `@openreceive/core` | Implemented | Shared error codes, rates, canonical price-provider fallback helpers, settlement, polling, storage, and NWC URI helpers. |
| `@openreceive/node` | Implemented | Receive-checkout adapter around `@getalby/sdk` NWC with canonical wallet-error normalization. |
| `@openreceive/express` | Implemented | Mounted HTTP routes, auth hooks, signed event URLs, idempotent create/refresh, lookup, SSE events, fulfillment hook, and static rates/routes/providers helpers. |
| `@openreceive/browser` | Implemented | Display-safe QR, copy, open-wallet, event parsing, checkout state reducer helpers, and redacted browser logging hooks. |
| `@openreceive/provider-data` | Implemented | Read-only helpers around the canonical provider registry, including provider-route vector coverage. |
| `@openreceive/testkit` | Implemented | Deterministic receive-client fixtures and conformance helpers. |
| `@openreceive/elements` | Implemented | No-framework checkout web component for display-safe invoice data, with optional redacted browser action logging. |
| `@openreceive/react` | Implemented | Hook, primitives, slot/component overrides, default checkout UI, and optional redacted browser action logging for display-safe invoice data. |
| `openreceive` Ruby | Initial core helpers | Vector-backed exact fiat quoting, settlement detection, NWC URI parse/redaction, receive-only NIP-47 request mapping, polling/idempotency helpers, an in-memory test store, a receive-only `nwc-ruby` wrapper, and an optional Ruby live smoke with opt-in invoice creation. CI skips wallet calls when `nwc-ruby` is unavailable. |
| `openreceive-rails` Ruby | Initial adapter helpers | Production fail-closed configuration, idempotent invoice creation, authorized lookup, worker/listener verification, backend settlement checks, passive notification handling, duplicate-safe fulfillment, ActiveRecord storage templates, controller/job/channel templates, Hotwire partial, install generator skeleton, and optional mounted engine routes around an injected receive-only client. Real-wallet Ruby smoke and demos are not implemented yet. |

## Demos

| Demo | Status | Notes |
| --- | --- | --- |
| Express + React Hello Fruit | Implemented | Express route adapter with React client UI. |
| Static HTML + Small API Hello Fruit | Implemented | Web component checkout with a small Express API. |
| Next.js Fullstack Hello Fruit | Implemented | App Router route handlers and React checkout UI in one server app. |

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
