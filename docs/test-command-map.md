# Test Command Map

| Command | Purpose | Requires Secrets |
| --- | --- | --- |
| `npm test` | Validate v0.1 JSON, schemas, vectors, provider references, and secret patterns. | No |
| `npm run validate` | Run contract/vector validation only. | No |
| `npm run scan:secrets` | Scan public repo files for likely committed NWC secrets and reject tracked non-example env files. | No |
| `npm run scan:client-bundles` | Scan generated demo `dist` bundles for browser-side NWC markers after `build:demo`. | No |
| `npm run generate:models` | Regenerate TypeScript contract constants from OpenAPI and AsyncAPI. | No |
| `npm run check:generated` | Fail when generated TypeScript contract constants are stale. | No |
| `npm run build:docs` | Validate the docs manifest and build the docs import/search artifact under `dist/docs`. | No |
| `npm run build:demo` | Build the Hello Fruit demos. | No |
| `npm run test:vectors` | Run vector validation. | No |
| `npm run test:live:nwc` | Live wallet smoke harness. Reads `OPENRECEIVE_NWC` from the environment or `OPENRECEIVE_ENV_FILE`, then skips clearly when unset. | Optional |

Future package commands should be added here before the package is considered
part of v0.1 CI.
