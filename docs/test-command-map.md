# Test Command Map

| Command | Purpose | Requires Secrets |
| --- | --- | --- |
| `npm test` | Validate v0.1 JSON, schemas, vectors, provider references, and secret patterns. | No |
| `npm run validate` | Run contract/vector validation only. | No |
| `npm run scan:secrets` | Scan public repo files for likely committed NWC secrets and reject tracked non-example env files. | No |
| `npm run generate:models` | Regenerate TypeScript contract constants from OpenAPI and AsyncAPI. | No |
| `npm run check:generated` | Fail when generated TypeScript contract constants are stale. | No |
| `npm run build:docs` | Validate the docs manifest and build the docs import/search artifact under `dist/docs`. | No |
| `npm run build:demo` | Build the Express + React Hello Fruit demo. | No |
| `npm run test:vectors` | Run vector validation. | No |
| `npm run test:live:nwc` | Live wallet smoke skeleton. Skips without `OPENRECEIVE_NWC`. | Optional |

Future package commands should be added here before the package is considered
part of v0.1 CI.
