# Contributing

OpenReceive is contract-first. The first contribution rule is to preserve one
source of truth for payment semantics.

## Local Checks

```sh
nvm use
npm ci
npm test
```

The repository pins local development to Node 22 in `.nvmrc`. Use `npm ci` so
the workspace lockfile, package build tooling, and generated checks match CI.

The current v0.1 checks validate JSON files, core schema constraints, test
vectors, the copied provider registry references, generated package contracts,
and basic secret patterns. Before declaring repository-wide work done, run:

```sh
npm run test:ci
```

If the change is intentionally narrow and the full gate is too broad while
iterating, run at minimum:

```sh
npm run typecheck
npm run test:js
```

## Development Rules

- Keep receive-only NWC codes server-side only.
- Use receive-only NWC codes for checkout examples.
- Use `amount_msats` for Lightning invoice amounts.
- Store and test `payment_hash` for every invoice.
- Treat provider routes as suggestions, not guarantees.
- Add or update test vectors when changing payment behavior.
- Keep private deployment and openreceive.org app details outside this repo.
- Keep repository package versions fixed together. Release changes publish the
  public JS package set from the monorepo in one coordinated version; do not
  independently bump one package without updating the release plan.

## Pull Request Shape

Small issue-shaped PRs are preferred. For v0.1, a PR should state:

- Which contract, package, tool, or doc it changes.
- Which test vectors were added or updated.
- Which command was run locally.
- Whether any live-wallet behavior was skipped because no receive-only NWC code was
  available.
