# Release Process

The release surface, all versioned in lockstep:

- OpenReceive `0.4.2`
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
- RubyGems: `openreceive`, `openreceive-server`, `openreceive-rails`

Public package manifests are public while testkit stays private. The public
surface includes the unscoped `openreceive` CLI package (a bin that forwards to
`@openreceive/node`), the Node service package, the shipped HTTP route handler
(`@openreceive/http`) and its framework adapters (`@openreceive/express`,
`@openreceive/fastify`, `@openreceive/next`), core contracts/helpers, browser
checkout helpers, provider-data assets, elements, and frontend adapters. The
root workspace and `@openreceive/testkit` stay private.

Three registries, three publishers:

| Registry | Who publishes | Credential |
| --- | --- | --- |
| npm (14 packages) | the maintainer's machine, `npm run release:publish` | granular token with "Bypass 2FA", loaded from `.env.release` |
| RubyGems (3 gems) | GitHub Actions, `.github/workflows/publish-gems.yml` | none stored: OIDC Trusted Publishing, approved per run in the `rubygems` environment |
| GitHub release | the maintainer's machine, `gh release create` | `gh` login for the OpenReceive account (`GH_CONFIG_DIR` from `.env.release`) |

## One-time setup

Everything below is already in place for the OpenReceive account and is listed
so it can be recreated or audited.

- `.env.release` at the repo root (gitignored) exports the npm userconfig, the
  `gh` config directory and `GH_REPO` for the OpenReceive identity, and a
  push-scoped `GEM_HOST_API_KEY` used only by the manual gem fallback. Every
  release shell sources it first.
- On rubygems.org each of the three gems has one entry under "Trusted
  publishers": repository owner `OpenReceive` (case-sensitive), repository
  `openreceive`, workflow filename `publish-gems.yml`, environment `rubygems`.
  RubyGems matches these against the OIDC token's claims, so the values must
  name the real repository, not a fork.
- On GitHub the `rubygems` environment has a required reviewer, does not let
  administrators bypass, and admits only `v*` tags. That approval click is the
  only thing standing between "someone pushed a tag" and "gems published".
  Edits to `publish-gems.yml` are edits to that trust boundary.
- Every gemspec sets `rubygems_mfa_required`, and the RubyGems account keeps MFA
  at "UI and API". A trusted-publisher key satisfies both, so nothing there
  changes for CI.

## Cutting a release

Run from the repo root on a clean, current `master`.

1. Load the identity and prove it:

   ```sh
   set -a; . ./.env.release; set +a
   npm whoami            # openreceive
   gh auth status        # OpenReceive
   git config user.email # info@openreceive.org
   ```

2. Preview, then prepare the version bump:

   ```sh
   npm run release:plan -- --version <x.y.z>
   npm run release:prepare -- --version <x.y.z> --dry-run
   npm run release:prepare -- --version <x.y.z>
   ```

   `release:prepare` rewrites, in lockstep: every workspace `package.json`
   version and internal `@openreceive/*` pin, the Ruby gem `VERSION` constants,
   the root and per-gem changelog headings (`## <x.y.z> - Unreleased`), the
   path-gem `Gemfile.lock` of the Rails example, the version references in this
   document, and the package lock. Nothing else is hand-edited for a bump.

3. Regenerate the version-stamped docs. `release:prepare` does not do this, and
   `check:docs` fails on each stale file otherwise:

   ```sh
   npm run build:docs
   ```

4. Write the release notes under `## <x.y.z> - Unreleased` in `CHANGELOG.md`
   and in each gem's `CHANGELOG.md` (prepare inserts empty sections). If the
   root changelog already had a bare `## Unreleased` section, merge it into the
   versioned heading. The heading text is load-bearing: `release:stamp` and
   `check:release` both match it literally. Then:

   ```sh
   npm run check:release
   ```

5. Run the full gate. Everything must be green; a red gate ends the release.

   ```sh
   npm run test:ci
   ```

6. Date the headings, commit, tag, push:

   ```sh
   npm run release:stamp -- --version <x.y.z>   # must report 4 changelogs
   git add -A && git commit -m "release: v<x.y.z>"
   git tag -a v<x.y.z> -m "OpenReceive v<x.y.z>"
   git push origin master && git push origin v<x.y.z>
   ```

   The push starts three workflows: `CI` on master, and `Release Dry Run` plus
   `Publish Gems` on the tag. `Release Dry Run` fails first if the tag does not
   match `package.json`.

7. Approve the gem publish. `Publish Gems` stops at the `rubygems` environment
   until a required reviewer approves it: Actions → Publish Gems → the run →
   "Review deployments" → tick `rubygems` → "Approve and deploy". The job then
   builds the three gems in a `ruby:3.4` container, exchanges its OIDC token for
   a 15-minute push-only key, and pushes `openreceive`, `openreceive-server`,
   `openreceive-rails` in that order (siblings are exact-pinned, so the order
   matters). A re-run after a partial push skips whatever already landed.

   ```sh
   gh run watch   # or: gh run list --workflow publish-gems.yml -L 1
   ```

8. Publish to npm once `CI` and `Release Dry Run` are green on the release
   commit, rehearsal first:

   ```sh
   npm run release:publish -- --tag latest --dry-run
   npm run release:publish -- --tag latest
   ```

   With both workflows green on the exact commit and a clean worktree, the
   script skips re-running `npm run test:ci` (between them the two workflows run
   every step of it). Otherwise, or without `gh`, it runs the suite locally;
   `--skip-tests` skips it unconditionally. It builds exact tarballs under
   `.release/npm/<version>/tarballs`, skips versions already on npm, and
   publishes only the public package family. Pass `--otp <code>` only on a
   machine whose npm account still has a TOTP authenticator; the OpenReceive
   account uses a bypass-2FA token instead.

9. Cut the GitHub release with the notes and the exact artifacts. The gems must
   come from RubyGems, since CI built them and a local build has different
   bytes:

   ```sh
   mkdir -p .release/gems/<x.y.z>/published && (cd .release/gems/<x.y.z>/published &&
     for g in openreceive openreceive-server openreceive-rails; do gem fetch "$g" -v <x.y.z>; done)
   gh release create v<x.y.z> --title "OpenReceive v<x.y.z>" \
     --notes-file <(awk '/^## <x.y.z> - /{f=1;next}/^## /{f=0}f' CHANGELOG.md) \
     .release/npm/<x.y.z>/tarballs/*.tgz .release/gems/<x.y.z>/published/*.gem
   ```

   `gem fetch` can lag the push by a minute while the index catches up; retry
   rather than fall back to a local build.

10. Verify from outside the workspace:

    ```sh
    cd "$(mktemp -d)"
    npm view @openreceive/core version
    gem list -r -e openreceive -e openreceive-server -e openreceive-rails
    gh release view v<x.y.z>     # 17 assets: 14 tarballs + 3 gems
    ```

11. Redeploy openreceive.org with this release's docs bundle (`bin/rails
    docs:sync`, the JS build, then deploy, in the site repo). Until then the
    public site serves the previous release's guides and footer version.

## RubyGems Track

The gems release in lockstep with the npm workspace version: `release:prepare`
bumps their `VERSION` constants and changelog headings, and `npm run
check:release` fails on any drift. Sibling gem dependencies are exact-pinned
through the shared `VERSION` constant, so no manual gemspec edits are needed.

`npm run release:gem:plan` is read-only and reports version drift, and `npm run
release:gem:build` builds the three `.gem` artifacts locally under
`.release/gems/<version>` (CI also builds them via `./tools/ci/ruby-gem-build.sh`
on every push/PR). RubyGems rewrites prerelease versions — a workspace version
of `0.2.0-alpha.0` becomes `0.2.0.pre.alpha.0` in both the artifact filename and
what rubygems.org reports — so the artifact directory is named for the workspace
version while the files inside carry the RubyGems form, and `gem install` needs
`--pre` to select a prerelease.

If `publish-gems.yml` cannot run, `tools/release/push-gems.sh --otp <code>` is
the manual fallback: it sources `.env.release`, proves the API key answers,
builds any missing artifact before reading a code, pushes the local build with
one fresh TOTP code per gem, and confirms each landed by checksum. It is safe
to re-run after a half-finished push.

Publish the npm packages and the gems from the same prepared commit so both
registries carry identical versions.

## Release checklist

The release owner checks, before tagging:

- `npm run test:ci` is green on the release commit.
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

## GitHub Workflows

- `.github/workflows/ci.yml` runs the full local gate on every push and PR.
- `.github/workflows/conformance.yml` runs contract, generated-model, JS, and
  internal testkit checks.
- `.github/workflows/demos.yml` validates and builds the Buy a Button example
  artifacts without injecting receive-only NWC codes.
- `.github/workflows/provider-registry.yml` validates canonical provider data.
- `.github/workflows/security.yml` runs secret and client-bundle boundary
  checks.
- `.github/workflows/release.yml` is a release dry run on every `v*` tag; with
  `ci.yml` it covers every `test:ci` step, which is what `release:publish`
  relies on to skip the local suite.
- `.github/workflows/publish-gems.yml` publishes the gems on a `v*` tag through
  RubyGems Trusted Publishing, gated by the `rubygems` environment's required
  approval. It is the only workflow allowed to run `gem push`.

`npm run check:workflows` requires read-only workflow permissions, expected
commands, SHA-pinned actions, concurrency groups, and that `gem push` appears
only in the gem publish workflow, whose jobs must run in the `rubygems`
environment with exactly `contents: read` + `id-token: write`.

## Tagging

Tag the prepared release commit once, as `v0.4.2`. Per-package tags are
deliberately not used while every package and gem releases in lockstep with the
workspace version. Introduce per-package tags only if versions ever diverge,
after the contract is stable enough to avoid confusing SDK consumers.

## Notes

Release notes should name which examples were rebuilt, which package versions
they run, and whether the live wallet smoke was skipped or paid manually.

Do not publish npm tarballs from automation: npm publishing stays on the
maintainer's machine, and the gems are the only registry a workflow writes to.
Do not expand new SDKs, framework adapters, React default UI, provider-data
variants, or generated models unless the shared contract and conformance gate
cover the behavior they expose.
