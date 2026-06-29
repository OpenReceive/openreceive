# Package Ownership Map

This map records current package ownership and which areas are safe for
parallel work. Shared contract files still need lead coordination.

| Area | Package or Path | Status | Owner |
| --- | --- | --- | --- |
| Contract schemas | `spec/schemas/**` | Active | Lead |
| Test vectors | `spec/test-vectors/**` | Active | Lead |
| JS core contracts | `packages/js/core` | Implemented, lead-owned | Lead |
| Node receive SDK | `packages/js/node` | Implemented | JS lane |
| Browser helpers | `packages/js/browser` | Implemented | Browser lane |
| Elements package | `packages/js/elements` | Implemented | Browser lane |
| React package | `packages/js/react` | Implemented | Frontend lane |
| Vue binding package | `packages/js/vue` | Initial web-component bindings | Frontend lane |
| Svelte binding package | `packages/js/svelte` | Initial web-component bindings | Frontend lane |
| Angular binding package | `packages/js/angular` | Initial web-component bindings | Frontend lane |
| Provider data package | `packages/js/provider-data` | Implemented | Data lane |
| Testkit package | `packages/js/testkit` | Implemented | Conformance lane |
| Ruby core package | `packages/ruby/openreceive` | Initial vector-backed helpers | Ecosystem lane |
| Hello Fruit demos | `examples/hello-fruit/**` | Implemented | Demo lane |
| Other non-JS SDKs | `packages/python`, `packages/php`, etc. | Deferred | Ecosystem lanes |

Safe post-reference parallel lanes:

- Provider-data API/test/doc polish that does not edit canonical provider data.
- Testkit conformance helpers that do not change production package behavior.
- API and security docs that use specs as source of truth.
- Read-only conformance/security review.

Do not let parallel contributors independently edit shared schemas, vectors,
settlement semantics, idempotency rules, or OpenAPI/AsyncAPI behavior without
lead coordination.
