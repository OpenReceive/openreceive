# Package Ownership Map

This map reserves package areas without approving broad implementation before
the v0.1 reference path is green.

| Area | Package or Path | v0.1 Status | Owner |
| --- | --- | --- | --- |
| Contract schemas | `spec/schemas/**` | Active | Lead |
| Test vectors | `spec/test-vectors/**` | Active | Lead |
| JS core contracts | `packages/js/core` | Active | Lead |
| Node receive SDK | `packages/js/node` | Next | JS worker |
| Browser helpers | `packages/js/browser` | Next | Browser worker |
| Express adapter | `packages/js/express` | Later in v0.1 | JS worker |
| Provider data package | `packages/js/provider-data` | Deferred | Data worker |
| Non-JS SDKs | `packages/python`, `packages/ruby`, etc. | Deferred | Ecosystem workers |

Shared contract files stay lead-owned until the Express reference path proves
invoice creation, polling, settlement verification, and fulfillment.
