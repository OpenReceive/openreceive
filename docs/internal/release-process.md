# Release Process

OpenReceive starts with a small v0.1 release surface:

- OpenReceive `0.1.1`
- `openreceive`
- `@openreceive/core`
- `@openreceive/node`
- `@openreceive/http`
- `@openreceive/express`
- `@openreceive/fastify`
- `@openreceive/next`
- `@openreceive/browser`
- `@openreceive/provider-data`
- `@openreceive/elements`
- `@openreceive/react`
- `@openreceive/vue`
- `@openreceive/svelte`
- `@openreceive/angular`

Public package manifests are public while testkit stays private. The public
surface includes the unscoped `openreceive` umbrella package, the Node service
package, the shipped HTTP route handler (`@openreceive/http`) and its framework
adapters (`@openreceive/express`, `@openreceive/fastify`, `@openreceive/next`),
core contracts/helpers, browser checkout helpers, provider-data assets,
elements, and frontend adapters. The root workspace and `@openreceive/testkit`
stay private. The Ruby gems (`openreceive`, `openreceive-server`,
`openreceive-rails`) release on the RubyGems track, separate from this npm
surface.

## Release Gate

Use the release helper for repeatable npm releases:

```sh
npm run release:plan -- --version patch
npm run release:prepare -- --version 0.1.1
npm run release:publish -- --tag latest
```

`release:plan` is read-only. `release:prepare` updates workspace package
versions, internal `@openreceive/*` dependency versions, the package lock,
changelog heading, and current release tags in this document. `release:publish`
runs the local release gate, builds exact tarballs under
`.release/npm/<version>/tarballs`, checks the target versions are not already on
npm, and publishes only the public package family. Pass
`--otp <code>` when npm requires a one-time password.

Before tagging or publishing a release:

```sh
npm run test:ci
```

The release owner also checks:

- Changelog updated.
- Public package manifests are public while testkit stays private.
- Package versions match the intended tag.
- JSON schemas and test vectors pass.
- OpenAPI and AsyncAPI validation passes through `npm run validate`.
- Secret scan passes.
- Workflow safety validation passes through `npm run check:workflows`.
- Package artifact dry run passes through `npm run build:packages`.
- Local package artifact smoke passes.
- Demo build passes.
- Live wallet smoke passes when a trusted `OPENRECEIVE_NWC` is available.

For a prepare preview without editing files:

```sh
npm run release:prepare -- --version 0.1.1 --dry-run
```

For a publish rehearsal that builds exact tarballs but asks npm not to publish:

```sh
npm run release:publish -- --tag latest --dry-run
```

## GitHub Workflows

The repository reserves these public workflow skeletons before publishing is
enabled:

- `.github/workflows/ci.yml` runs the full local gate.
- `.github/workflows/conformance.yml` runs contract, generated-model, JS, and
  internal testkit checks.
- `.github/workflows/demos.yml` validates and builds Hello Fruit example
  artifacts without injecting receive-only NWC codes.
- `.github/workflows/provider-registry.yml` validates canonical provider data.
- `.github/workflows/security.yml` runs secret and client-bundle boundary
  checks.
- `.github/workflows/release.yml` is a release dry run only.
- `.github/workflows/publish.yml` keeps publishing disabled until explicit
  maintainer approval.

`npm run check:workflows` requires read-only workflow permissions, expected
commands, concurrency groups, and the disabled publish path.

## Suggested Tags

- `v0.1.1`
- `js-openreceive-v0.1.1`
- `js-core-v0.1.1`
- `js-node-v0.1.1`
- `js-browser-v0.1.1`
- `js-provider-data-v0.1.1`
- `js-testkit-v0.1.1`
- `js-elements-v0.1.1`
- `js-react-v0.1.1`
- `js-vue-v0.1.1`
- `js-svelte-v0.1.1`
- `js-angular-v0.1.1`

Use independent package versions later, after the contract is stable enough to
avoid confusing SDK consumers.

## Notes

Release notes should name which examples were rebuilt, which package versions
they run, and whether the live wallet smoke was skipped or paid manually.

Do not publish package tarballs from automation until the disabled publish
workflow is explicitly enabled by a maintainer. Do not expand new SDKs,
framework adapters, React default UI, provider-data variants, or generated
models unless the shared contract and conformance gate cover the behavior they
expose.
