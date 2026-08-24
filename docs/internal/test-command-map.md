# Test Command Map

| Command | Purpose | Requires Secrets |
| --- | --- | --- |
| `npm test` | Run the Node test suite (`test:js`). `pretest:js` first builds the Angular dist chain — the one `@openreceive/*` import under `tests/` with no tsconfig `paths` entry. | No |
| `npm run check` | Run the fast local gate: `validate` (JSON/schema/vector/provider validation plus generated-doc-table freshness) then `scan:secrets`. | No |
| `npm run test:ci` | Run the full repository gate: `test:ci:core` then `test:ci:release`. | No |
| `npm run test:ci:core` | Deterministic source gate, and exactly what `ci.yml` runs per push: `check`, lint, format check, workflow and example-import checks, generated-model freshness, public-API surface check, typecheck, Vue and Svelte checks, dead-export check, JS tests, package smoke. | No |
| `npm run test:ci:release` | Release-shaped gate: build packages, Ruby tests, demo container and release checks, Rails example tests, demo builds, client-bundle scan, docs build. | No |
| `npm run test:live` | Live NWC smoke against a real wallet (Node + Ruby). Never part of the deterministic gate. | Yes |
| `npm run test:e2e` | Playwright end-to-end suite: boots the node-express Hello Fruit demo in `DEMO_WALLET=testkit` mode and drives real Chromium through all four framework tabs (lightning, swap + refund, remint, resume/theme). Run `npm run build:packages` first: the demo's vite server resolves `@openreceive/*` to the built dists, and a stale dist fails the boot with a missing-export error (CI builds before every run for the same reason). Server stdout is piped (demo boot / `on_paid`, OpenReceive INFO). `LOG_LEVEL=DEBUG` for more OpenReceive detail; `--headed` / `--ui` to watch the browser. Weekly full run in `demos.yml`. | No |
| `npm run test:e2e:smoke` | The lightning spec's React tab only — the per-push `e2e-smoke` job in `ci.yml`. | No |
| `npm run check:public-api` | Diff every publishable package's export surface against the committed snapshot (`tools/validate/public-api.snapshot.json`) — the gate behind the curated adapter/wrapper surfaces. Regenerate a reviewed change with `--update`. | No |
| `npm run check:vue` | Type-check the Vue wrapper with `vue-tsc`. | No |
| `npm run check:svelte` | Type-check the Svelte wrapper with `svelte-check`. | No |
| `npm run validate` | Contract/vector validation plus generated doc-table freshness (spec route/error tables, headless symbol inventory). Vector validation runs here — there is no separate `test:vectors` command. | No |
| `npm run scan:secrets` | Scan public repo files for likely committed receive-only NWC codes and reject tracked env files. | No |
| `npm run scan:client-bundles` | Scan generated demo `dist` bundles for browser-side NWC markers after `build:demo`. | No |
| `npm run generate:models` | Regenerate TypeScript contract constants from OpenAPI and AsyncAPI. | No |
| `npm run typecheck` | Typecheck all JS/TS packages and Hello Fruit server/demo TypeScript. | No |
| `npm run test:js` | Run the Node test suite, including browser/react/elements/framework adapter contract tests and real Vue/Svelte/Angular wrapper mounts. | No |
| `npm run test:ruby` | Run the Ruby tests (glob-discovered per gem) against shared vectors and receive-only behavior. Each gem's own `rake test` also works from its directory. | No |
| `npm run test:live:ruby:nwc` | Optional Ruby live-wallet smoke. Reads `NWC_URI` from the environment or root `.env`, redacts the connection string, runs `get_info` when `nwc-ruby` is installed, and creates an invoice only with `OPENRECEIVE_LIVE_CREATE_INVOICE=1`. | Optional |
| `npm run check:generated` | Fail when generated TypeScript contract constants are stale. | No |
| `npm run check:demo-containers` | Validate Hello Fruit Dockerfiles, compose templates, root `.env` loading, ports, and secret boundaries. | No |
| `npm run check:release` | Validate release-readiness metadata, package versions, private package status, and changelog coverage. | No |
| `npm run check:workflows` | Validate GitHub workflow shape, read-only permissions, safe commands, and disabled publish path. | No |
| `npm run build:docs` | Validate the docs manifest and build the docs import/search artifact under `dist/docs`. | No |
| `npm run build:demo` | Build the Hello Fruit demos. | No |
| `npm run test:package-smoke` | Pack every JS workspace package into local tarballs, assemble an offline temporary project, and import each package. | No |
| `npm run test -w @openreceive/example-rails` | Run the Rails Hello Fruit example's own test suite (also a per-push CI job). | No |
| `npm run test:live:nwc` | Live wallet smoke harness. Reads `NWC_URI` from the environment or root `.env`, checks `tools/live-nwc-test/expected_capabilities.json` by default, then skips clearly when unset. | Optional |
