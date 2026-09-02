# Release Process

The npm release surface, all versioned in lockstep:

- OpenReceive `0.3.3`
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
surface includes the unscoped `openreceive` CLI package (a bin that forwards to
`@openreceive/node`), the Node service
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
npm run release:prepare -- --version 0.2.0-alpha.1
npm run release:publish -- --tag latest
```

`release:plan` is read-only. `release:prepare` updates workspace package
versions, internal `@openreceive/*` dependency versions, the Ruby gem version
files and gem changelogs, the package lock, changelog headings, and current
release tags in this document. `release:publish`
runs the local release gate, builds exact tarballs under
`.release/npm/<version>/tarballs`, checks the target versions are not already on
npm, and publishes only the public package family. Pass
`--otp <code>` when npm requires a one-time password.

Just before tagging, date the changelog headings (root and per-gem) for the
release:

```sh
npm run release:stamp
```

## RubyGems Track

The Ruby gems (`openreceive`, `openreceive-server`, `openreceive-rails`)
release in lockstep with the npm workspace version: `release:prepare` bumps
their `VERSION` constants and changelog headings, and `npm run check:release`
fails on any drift. Sibling gem dependencies are exact-pinned through the
shared `VERSION` constant, so no manual gemspec edits are needed.

```sh
npm run release:gem:plan
npm run release:gem:build
npm run release:gem:publish -- --otp <code>
```

`release:gem:plan` is read-only and reports version drift.
`release:gem:build` builds all three `.gem` artifacts under
`.release/gems/<version>` (CI builds the gems via `./tools/ci/ruby-gem-build.sh`
on every push/PR). RubyGems rewrites prerelease versions — a workspace version
of `0.2.0-alpha.0` becomes `0.2.0.pre.alpha.0` in both the artifact filename and
what rubygems.org reports — so the artifact directory is named for the workspace
version while the files inside carry the RubyGems form, and `gem install`
needs `--pre` to select a prerelease. `release:gem:publish` requires a clean worktree, runs
`npm run test:ruby`, checks the target versions are not already on RubyGems,
rebuilds, and pushes in dependency order (`openreceive`,
`openreceive-server`, `openreceive-rails`). The RubyGems account requires MFA
(`rubygems_mfa_required` is set in every gemspec); pass `--otp <code>`.

Publish the npm packages and the gems from the same prepared commit so both
registries carry identical versions.

Before tagging or publishing a release:

```sh
npm run test:ci
```

The release owner also checks:

- Changelog updated.
- Agent skills describe the current public API. A release that changes the
  public API updates `skills/*/SKILL.md` in the same change, and
  `npm run generate:skills` has been run so the `.agents/skills/` twin and
  every package and gem copy match (`npm run check:docs` enforces the sync,
  not the prose).
- Public package manifests are public while testkit stays private.
- Package versions match the intended tag.
- Ruby gem versions match the workspace version and `npm run release:gem:build` passes.
- JSON schemas and test vectors pass.
- OpenAPI and AsyncAPI validation passes through `npm run validate`.
- Secret scan passes.
- Workflow safety validation passes through `npm run check:workflows`.
- Package artifact dry run passes through `npm run build:packages`.
- Local package artifact smoke passes.
- Demo build passes.
- Live wallet smoke passes when a trusted `NWC_URI` is available in the environment.
- After publishing: openreceive.org is redeployed with this release's docs
  bundle (`bin/rails docs:sync`, the JS build, then deploy, in the site repo).
  Until that happens the public site keeps serving the previous release's
  guides and footer version — the guides the freshly published packages link
  to are the ones that must be live.

For a prepare preview without editing files:

```sh
npm run release:prepare -- --version 0.2.0-alpha.1 --dry-run
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
- `.github/workflows/demos.yml` validates and builds the Buy a Button example
  artifacts without injecting receive-only NWC codes.
- `.github/workflows/provider-registry.yml` validates canonical provider data.
- `.github/workflows/security.yml` runs secret and client-bundle boundary
  checks.
- `.github/workflows/release.yml` is a release dry run only.
- `.github/workflows/publish.yml` keeps publishing disabled until explicit
  maintainer approval.

`npm run check:workflows` requires read-only workflow permissions, expected
commands, concurrency groups, and the disabled publish path.

## Tagging

Tag the prepared release commit once, as `v0.3.3` — no release tags exist yet,
and per-package tags are deliberately not used while every package and gem
releases in lockstep with the workspace version. Introduce per-package tags
only if versions ever diverge, after the contract is stable enough to avoid
confusing SDK consumers.

## Notes

Release notes should name which examples were rebuilt, which package versions
they run, and whether the live wallet smoke was skipped or paid manually.

Do not publish package tarballs from automation until the disabled publish
workflow is explicitly enabled by a maintainer. Do not expand new SDKs,
framework adapters, React default UI, provider-data variants, or generated
models unless the shared contract and conformance gate cover the behavior they
expose.
