---
name: package-smoke-yaml-preexisting
description: npm run test:package-smoke fails locally on the yaml transitive dep — pre-existing, not a regression
metadata:
  type: project
---

`npm run test:package-smoke` (and therefore the full `npm run test:ci`, which runs it before build:demo) fails on this machine with `ERR_MODULE_NOT_FOUND: Cannot find package 'yaml'` imported from `@openreceive/node/dist/chunk-*.js`.

`yaml` is a legitimate declared dependency of `@openreceive/node` (used by `src/config.ts` for openreceive.yml parsing). The offline package-smoke harness just fails to resolve it in the assembled temp install.

**Why:** Confirmed pre-existing — `git stash --include-untracked` to a clean HEAD and re-running `test:package-smoke` fails identically. Not caused by feature work.

**How to apply:** When `test:ci` dies at the package-smoke step on `yaml`, don't chase it as your regression. Verify the rest of the gate by running the downstream steps directly: `build:demo`, `scan:client-bundles`, `check:release`, `check:workflows`, `check:demo-containers`, `check:demo-deploy`, `test:ruby`, plus `typecheck` / `test:js` / `npm test`.
