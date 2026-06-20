# SDK Status

This page tracks what exists in the repository, not what has been published to a
package registry.

| Package | Status | Notes |
| --- | --- | --- |
| `@openreceive/core` | Implemented | Shared error codes, rates, settlement, polling, storage, and NWC URI helpers. |
| `@openreceive/node` | Implemented | Receive-checkout adapter around `@getalby/sdk` NWC with canonical wallet-error normalization. |
| `@openreceive/express` | Implemented | Mounted HTTP routes, auth hooks, signed event URLs, idempotent create/refresh, lookup, SSE events, fulfillment hook, and static rates/routes/providers helpers. |
| `@openreceive/browser` | Implemented | Display-safe QR, copy, and open-wallet helpers. |
| `@openreceive/provider-data` | Implemented | Read-only helpers around the canonical provider registry. |
| `@openreceive/testkit` | Implemented | Deterministic receive-client fixtures and conformance helpers. |
| `@openreceive/elements` | Implemented | No-framework checkout web component for display-safe invoice data. |
| `@openreceive/react` | Implemented | Hook, primitives, and default checkout UI for display-safe invoice data. |

Non-JS SDKs are planned only after the JS reference path and conformance gate
are stable. Future SDKs must consume shared vectors and must not expose NWC
secrets to browser or mobile runtime code.

## Current Gate

Run:

```sh
npm run test:ci
```

The current gate covers schemas, vectors, source secret scanning, TypeScript
typecheck, JavaScript tests, local package artifact imports, demo builds,
generated client-bundle scanning, docs build, and optional live NWC smoke.
