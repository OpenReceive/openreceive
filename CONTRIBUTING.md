# Contributing

OpenReceive is contract-first. The first contribution rule is to preserve one
source of truth for payment semantics.

## Local Checks

```sh
npm test
```

The current v0.1 checks are dependency-free and validate JSON files, core
schema constraints, test vectors, the copied provider registry references, and
basic secret patterns.

## Development Rules

- Keep receive-only NWC codes server-side only.
- Use receive-only NWC codes for checkout examples.
- Use `amount_msats` for Lightning invoice amounts.
- Store and test `payment_hash` for every invoice.
- Treat provider routes as suggestions, not guarantees.
- Add or update test vectors when changing payment behavior.
- Keep private deployment and openreceive.org app details outside this repo.

## Pull Request Shape

Small issue-shaped PRs are preferred. For v0.1, a PR should state:

- Which contract, package, tool, or doc it changes.
- Which test vectors were added or updated.
- Which command was run locally.
- Whether any live-wallet behavior was skipped because no receive-only NWC code was
  available.
