# Test Command Map

| Command | Purpose | Requires Secrets |
| --- | --- | --- |
| `npm test` | Validate v0.1 JSON, schemas, vectors, provider references, and secret patterns. | No |
| `npm run validate` | Run contract/vector validation only. | No |
| `npm run scan:secrets` | Scan public repo files for likely committed NWC secrets. | No |
| `npm run test:vectors` | Run vector validation. | No |
| `npm run test:live:nwc` | Live wallet smoke skeleton. Skips without `OPENRECEIVE_NWC`. | Optional |

Future package commands should be added here before the package is considered
part of v0.1 CI.
