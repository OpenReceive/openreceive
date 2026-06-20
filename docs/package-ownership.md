# Package Ownership Map

This map records current package ownership and which areas are safe for
parallel work. Shared contract files still need lead coordination.

| Area | Package or Path | Status | Owner |
| --- | --- | --- | --- |
| Contract schemas | `spec/schemas/**` | Active | Lead |
| Test vectors | `spec/test-vectors/**` | Active | Lead |
| JS core contracts | `packages/js/core` | Implemented, lead-owned | Lead |
| Node receive SDK | `packages/js/node` | Implemented | JS worker |
| Express adapter | `packages/js/express` | Implemented | JS worker |
| Browser helpers | `packages/js/browser` | Implemented | Browser worker |
| Elements package | `packages/js/elements` | Implemented | Browser worker |
| React package | `packages/js/react` | Implemented | Frontend worker |
| Vue binding package | `packages/js/vue` | Initial web-component bindings | Frontend worker |
| Svelte binding package | `packages/js/svelte` | Initial web-component bindings | Frontend worker |
| Angular binding package | `packages/js/angular` | Initial web-component bindings | Frontend worker |
| Provider data package | `packages/js/provider-data` | Implemented | Data worker |
| Testkit package | `packages/js/testkit` | Implemented | Conformance worker |
| Ruby core package | `packages/ruby/openreceive` | Initial vector-backed helpers | Ecosystem worker |
| Rails adapter package | `packages/ruby/openreceive-rails` | Initial server-side adapter helpers | Ecosystem worker |
| Hello Fruit demos | `examples/hello-fruit/**` | Implemented | Demo worker |
| Other non-JS SDKs | `packages/python`, `packages/php`, etc. | Deferred | Ecosystem workers |

Safe post-reference parallel lanes:

- Provider-data API/test/doc polish that does not edit canonical provider data.
- Testkit conformance helpers that do not change production package behavior.
- API and security docs that use specs as source of truth.
- Read-only conformance/security review.

Do not let parallel workers independently edit shared schemas, vectors,
settlement semantics, idempotency rules, or OpenAPI/AsyncAPI behavior without
lead coordination.
