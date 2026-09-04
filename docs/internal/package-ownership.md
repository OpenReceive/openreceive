# Package Ownership Map

This map records current package ownership and which areas are safe for
parallel work. Shared contract files still need lead coordination.

| Area | Package or Path | Status | Owner |
| --- | --- | --- | --- |
| Contract schemas | `spec/schemas/**` | Active | Lead |
| Test vectors | `spec/test-vectors/**` | Active | Lead |
| JS core contracts | `packages/js/core` | Implemented, lead-owned | Lead |
| Node receive SDK | `packages/js/node` | Implemented | JS lane |
| HTTP handler + adapters | `packages/js/http`, `express`, `fastify`, `next` | Implemented | JS lane |
| CLI package | `packages/js/openreceive` (`npx openreceive`, a bin forwarding to `@openreceive/node/cli`) | Implemented | JS lane |
| Browser helpers | `packages/js/browser` | Implemented | Browser lane |
| Elements package | `packages/js/elements` | Implemented | Browser lane |
| React package | `packages/js/react` | Implemented | Frontend lane |
| Vue binding package | `packages/js/vue` | Initial web-component bindings | Frontend lane |
| Svelte binding package | `packages/js/svelte` | Initial web-component bindings | Frontend lane |
| Angular binding package | `packages/js/angular` | Initial web-component bindings | Frontend lane |
| Provider data package | `packages/js/provider-data` | Implemented | Data lane |
| Testkit package | `packages/js/testkit` | Implemented | Conformance lane |
| Ruby core package | `packages/ruby/openreceive` | Implemented (vector-backed) | Ecosystem lane |
| Ruby server + Rails | `packages/ruby/openreceive-server`, `openreceive-rails` | Implemented | Ecosystem lane |
| BTCPay Server plugin | `packages/dotnet/BTCPayServer.Plugins.OpenReceive` | Implemented (vector-backed, third engine) | Ecosystem lane |
| BTCPay plugin tests | `packages/dotnet/BTCPayServer.Plugins.OpenReceive.Tests` | Implemented | Conformance lane |
| Testkit NWC wallet service + fake LSC provider | `packages/dotnet/OpenReceive.TestkitNwc`, `packages/dotnet/OpenReceive.FakeLsc` | Implemented | Conformance lane |
| BTCPay regtest stack | `packages/dotnet/docker/**` | Implemented | Conformance lane |
| BTCPay source pin | `packages/dotnet/submodules/btcpayserver` (submodule, v2.4.2) | Pinned per release | Lead |
| Buy a Button examples | `examples/buttons/**` | Implemented | Example lane |
| Other non-JS SDKs | `packages/python`, `packages/php`, etc. | Deferred | Ecosystem lanes |

`packages/dotnet/BTCPayServer.Plugins.OpenReceive/Generated/OpenReceiveTables.cs` is
generated from `spec/data/kernel-tables.json` and follows the lead-owned contract files, not
the plugin lane.

Why this many packages: each framework adapter (`express`, `fastify`, `next`;
`react`, `vue`, `svelte`, `angular`) carries its own framework peer
dependency, so a host installs exactly one framework's peer set and nothing
else. The unscoped `openreceive` package is the CLI only; the library ships as
the scoped packages.

Safe post-reference parallel lanes:

- Provider-data API/test/doc polish that does not edit canonical provider data.
- Testkit conformance helpers that do not change production package behavior.
- API and security docs that use specs as source of truth.
- Read-only conformance/security review.

Do not let parallel contributors independently edit shared schemas, vectors,
settlement semantics, idempotency rules, or OpenAPI/AsyncAPI behavior without
lead coordination.
