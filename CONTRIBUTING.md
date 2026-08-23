# Contributing to OpenReceive

Thanks for helping build OpenReceive. The short version:

## Setup

- Node ≥ 22 and Ruby ≥ 3.2 (every gemspec's `required_ruby_version`; CI tests 3.2 and 3.4).
- `npm ci`, then `npm test` for the JS suite and `npm run test:ruby` for the
  Ruby engine + cross-language conformance harness.
- `npm run check` runs the contract validators and secret scan; `npm run lint`
  and `npm run typecheck` must both be clean.

## Repository layout

- `spec/` — the source of truth: schemas, shared data, test vectors, and the
  shipped HTTP and event contracts.
- `packages/js/` — core contracts, the Node NWC wallet client, HTTP routes,
  Express/Fastify/Next adapters, browser helpers, provider data, testkit,
  elements, and the React/Vue/Svelte/Angular packages.
- `packages/ruby/` — the dependency-free core, the Service and Rack app, and
  the mountable Rails engine: a second settlement implementation checked
  against the shared vectors.
- `examples/hello-fruit/server/` — Express, static HTML, Next.js, and Rails
  demos; demo order models are ordinary application code.
- `tools/` — validation, conformance, package-smoke, documentation, and
  live-wallet helpers.

Versions are independent per domain: the workspace/package release version
([Release process](docs/internal/release-process.md)), the OpenAPI HTTP
contract (`spec/openapi/openreceive-http.v1.yaml`), and the AsyncAPI event
contract (`spec/asyncapi/openreceive-events.v1.yaml`) are each versioned inside
their own file, and none tracks the others.

## Ground rules

- Read `AGENTS.md` first — it holds the non-negotiable invariants (exact
  integer/decimal money math, fail-closed wallet handling, the JS/Ruby
  second-settlement-engine parity mandate, and the vector-update rule:
  schema or route changes update their spec vectors in the same change).
- The wire contract is `spec/openapi/openreceive-http.v1.yaml`; shared
  behavior lives in `spec/test-vectors/` and must stay green in BOTH engines
  (`tools/conformance/ruby-crosslang.rb` runs the Ruby side).
- Public docs live in `docs/guides/`; contributor/operator docs in
  `docs/internal/` (`docs/internal/README.md` is the index).

## Pull requests

- Keep changes focused; include tests for behavior changes.
- CI runs `npm run test:ci:core` on every push and PR (JS suite, package
  smoke, lint, typecheck, the public-API snapshot, and the validators) plus
  `npm run test:ruby` — run the same two commands locally.
- Security reports: see `SECURITY.md` (do not open public issues for
  vulnerabilities).
