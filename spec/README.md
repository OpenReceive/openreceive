# spec/

The normative contract: what every OpenReceive engine (JS and Ruby) must agree
on. Four version numbers live here, each meaning one thing.

| Number | Where | Meaning |
| --- | --- | --- |
| `info.version` (`0.4.0` in the OpenAPI, `0.2.0` in the AsyncAPI) | `openapi/*.yaml:4`, `asyncapi/*.yaml:4` | **The contract version — the one to cite.** Semver per document: a breaking change to a route or event bumps the major (minor while `0.x`), an additive change bumps the minor. |
| `v1` in a filename | `openapi/openreceive-http.v1.yaml`, `asyncapi/openreceive-events.v1.yaml` | The major line of that document. It changes only when a new major ships alongside the old one; it is not a version to cite. |
| `vN` in a schema `$id` | `schemas/*.schema.json` (`checkout.v2`, `provider-registry.v4`, …) | Each JSON Schema versions independently, in its `$id`, because schemas are reused across documents. Filenames carry no version so references never churn. |
| `OPENRECEIVE_*_CONTRACT_VERSION` | `packages/js/core/src/generated/contracts.ts` | Generated copies of the two `info.version` values (`npm run generate:models`); `npm run check:generated` fails when they drift. |

`test-vectors/` holds the shared behavior both engines must reproduce, and
`test-vectors/coverage.json` says which engine consumes which family (or why it is
exempt). `data/` holds canonical provider data and `data/kernel-tables.json`, the one
hand-edited copy of the vocabularies and numbers every engine shares — `npm run
generate:models` renders it into the JS, Ruby, and C# engines. Route or schema changes update their vectors in
the same change (AGENTS.md), and `npm run check` validates all of it.
