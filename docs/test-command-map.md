# Test Command Map

| Command | Purpose | Requires Secrets |
| --- | --- | --- |
| `npm test` | Validate v0.1 JSON, schemas, vectors, provider references, and secret patterns. | No |
| `npm run validate` | Run contract/vector validation only. | No |
| `npm run scan:secrets` | Scan public repo files for likely committed NWC secrets and reject tracked non-example env files. | No |
| `npm run scan:client-bundles` | Scan generated demo `dist` bundles for browser-side NWC markers after `build:demo`. | No |
| `npm run generate:models` | Regenerate TypeScript contract constants from OpenAPI and AsyncAPI. | No |
| `npm run check:generated` | Fail when generated TypeScript contract constants are stale. | No |
| `npm run check:demo-containers` | Validate Hello Fruit Dockerfiles, compose templates, optional env-file wiring, ports, and secret boundaries. | No |
| `npm run check:demo-deploy` | Validate public hosted-demo deploy templates, manifests, scripts, proxy wiring, and secret boundaries. | No |
| `npm run check:release` | Validate v0.1 release-readiness metadata, package versions, private package status, and changelog coverage. | No |
| `npm run check:workflows` | Validate GitHub workflow shape, read-only permissions, safe commands, and disabled publish path. | No |
| `npm run mock-wallet` | Start the deterministic local mock wallet service for conformance testing. | No |
| `npm run build:docs` | Validate the docs manifest and build the docs import/search artifact under `dist/docs`. | No |
| `npm run build:demo` | Build the Hello Fruit demos. | No |
| `npm run test:package-smoke` | Pack every JS workspace package into local tarballs, install them into a temporary project, and import each package. | No |
| `npm run test:vectors` | Run vector validation. | No |
| `npm run test:live:nwc` | Live wallet smoke harness. Reads `OPENRECEIVE_NWC` from the environment or `OPENRECEIVE_ENV_FILE`, then skips clearly when unset. | Optional |
