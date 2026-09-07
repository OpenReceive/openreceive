# Release Process

The release surface, all versioned in lockstep:

- OpenReceive `0.4.5`
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
- PyPI: `openreceive` (`packages/python/openreceive`; `_version.py` carries the
  PEP 440 form of the workspace version, `0.5.0-alpha.1` → `0.5.0a1`)
- Packagist: `openreceive/openreceive` (`packages/php/openreceive`;
  `src/Version.php` carries the version, `composer.json` none — Packagist tags)
  and `openreceive/laravel` (`packages/php/laravel`, pinned to the engine with
  `~X.Y.Z`), each published through a read-only split repository

Public package manifests are public while testkit stays private. The public
surface includes the unscoped `openreceive` CLI package (a bin that forwards to
`@openreceive/node`), the Node service package, the shipped HTTP route handler
(`@openreceive/http`) and its framework adapters (`@openreceive/express`,
`@openreceive/fastify`, `@openreceive/next`), core contracts/helpers, browser
checkout helpers, provider-data assets, elements, and frontend adapters. The
root workspace and `@openreceive/testkit` stay private.

Five registries, five publishers:

| Registry | Who publishes | Credential |
| --- | --- | --- |
| npm (14 packages) | the maintainer's machine, `npm run release:publish` | granular token with "Bypass 2FA", loaded from `.env.release` |
| RubyGems (3 gems) | GitHub Actions, `.github/workflows/publish-gems.yml` | none stored: OIDC Trusted Publishing, approved per run in the `rubygems` environment |
| PyPI (1 distribution) | GitHub Actions, `.github/workflows/publish-pypi.yml` | none stored: OIDC Trusted Publishing, approved per run in the `pypi` environment |
| Packagist (2 packages) | GitHub Actions, `.github/workflows/publish-composer.yml` — pushes the split repositories Packagist watches | separate write-enabled deploy keys: `COMPOSER_OPENRECEIVE_SSH_KEY` for `OpenReceive/openreceive-php`, `COMPOSER_LARAVEL_SSH_KEY` for `OpenReceive/openreceive-laravel`, both in the protected `packagist` environment |
| GitHub release | the maintainer's machine, `gh release create` | `gh` login for the OpenReceive account (`GH_CONFIG_DIR` from `.env.release`) |

## One-time setup

These entries describe the account and environment configuration each release
path requires. Check the registry and GitHub settings before the first release;
workflow files cannot create accounts or enforce environment reviewer settings.

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
- On pypi.org the `openreceive` project has one "Trusted publisher": owner
  `OpenReceive`, repository `openreceive`, workflow `publish-pypi.yml`,
  environment `pypi`. On GitHub the `pypi` environment mirrors `rubygems`: a
  required reviewer, no administrator bypass, `v*` tags only. Until the first
  upload exists the entry is a "pending publisher" created on PyPI under the
  same four values; the first approved run claims the name.
- Packagist has no upload API and cannot read a monorepo, so each Composer
  package lives in a read-only split repository — `OpenReceive/openreceive-php`
  for `openreceive/openreceive`, `OpenReceive/openreceive-laravel` for `openreceive/laravel`
  — registered on packagist.org with the Packagist GitHub App (or its webhook)
  so pushed tags become versions. First create a [Packagist account](https://packagist.org/register/)
  and the two empty public repositories. Protect the `packagist` GitHub
  environment with a required reviewer, no administrator bypass, and `v*` tags
  only before adding credentials. Generate **two different** ed25519 key pairs
  without passphrases for unattended publishing. Add each public key as a deploy
  key with **Allow write access** on its corresponding split repository. Store
  the engine private key as `COMPOSER_OPENRECEIVE_SSH_KEY` and the Laravel private
  key as `COMPOSER_LARAVEL_SSH_KEY` in that environment. [GitHub deploy keys cannot
  be reused across repositories](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys).
  The workflow selects each key through a separate SSH alias, pins GitHub's
  public host key, and removes temporary key files when the publish step exits.
  Nobody commits to a split repository by hand; every release force-pushes
  `main` from a fresh `git subtree split`, while version tags are immutable.

  For the first publication, commit the workflow changes and prepare a new
  release tag. Cancel that tag's automatic **Publish Composer** run before
  dispatching it manually at the same tag with **bootstrap** checked; the
  concurrency gate otherwise queues the manual run behind the automatic one.
  Approve the protected environment. Bootstrap pushes **both** repositories and
  tags with `--skip-packagist`, because neither package is registered yet.
  [Submit both populated repositories to Packagist](https://packagist.org/packages/submit)
  and enable automatic updates. Then dispatch the same tag with **bootstrap
  unchecked** and approve it to verify registry discovery. Later tag-triggered
  releases always poll Packagist. A bootstrap success only confirms the split
  pushes; it does not confirm a public Packagist release.

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
   the Python `_version.py` (PEP 440), the PHP `OpenReceive\Version::VERSION`
   and the Laravel package's `~X.Y.Z` constraint on the engine,
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

5. The full gate must pass on the exact release commit, as shown below.
   Run focused checks while preparing changes, then commit and run the full
   gate once. If a fix changes the commit, run the gate on the corrected commit
   before tagging. A red gate stops publication.

6. Date the headings and commit, then run the full gate on that exact commit
   before creating the new tag and pushing:

   ```sh
   npm run release:stamp -- --version <x.y.z>   # must report 4 changelogs
   git add -A && git commit -m "release: v<x.y.z>"
   npm run test:ci
   git diff --exit-code && test -z "$(git status --porcelain)"
   git tag -a v<x.y.z> -m "OpenReceive v<x.y.z>"
   git push origin master && git push origin v<x.y.z>
   ```

   The push starts five workflows: `CI` on master, and `Release Dry Run`,
   `Publish Gems`, `Publish PyPI` and `Publish Composer` on the tag. `Release
   Dry Run` fails first if the tag does not match `package.json`.

   **Hand over the approval URLs right now**, before anything else: all three
   publish workflows stop at their environment until a human approves them,
   and the release is stalled until that click. Print them and give them to
   the maintainer as a release step, not a footnote:

   ```sh
   gh run list --workflow publish-gems.yml -L 1 --json url,status --jq '.[0] | "\(.status) \(.url)"'
   gh run list --workflow publish-pypi.yml -L 1 --json url,status --jq '.[0] | "\(.status) \(.url)"'
   gh run list --workflow publish-composer.yml -L 1 --json url,status --jq '.[0] | "\(.status) \(.url)"'
   ```

7. Approve the gem publish. `Publish Gems` stops at the `rubygems` environment
   until a required reviewer approves it in the browser (the approval cannot
   be scripted from this machine). Print the run's URL and hand it to the
   maintainer straight away — the gems, and the GitHub release that needs the
   published gems, wait on that click. Whoever runs the release (a person or
   an agent) reports this URL as a release step, not as a footnote:

   ```sh
   gh run list --workflow publish-gems.yml -L 1 --json url,status --jq '.[0] | "\(.status) \(.url)"'
   ```

   It has the shape `https://github.com/OpenReceive/openreceive/actions/runs/<id>`
   and shows "waiting" until approved. On that page: "Review deployments" →
   tick `rubygems` → "Approve and deploy". The job then
   builds the three gems in a `ruby:3.4` container, exchanges its OIDC token for
   a 15-minute push-only key, and pushes `openreceive`, `openreceive-server`,
   `openreceive-rails` in that order (siblings are exact-pinned, so the order
   matters). A re-run after a partial push skips whatever already landed.

   ```sh
   gh run watch   # or: gh run list --workflow publish-gems.yml -L 1
   ```

7b. Approve the PyPI publish the same way. `Publish PyPI` waits at the `pypi`
   environment; on its run page "Review deployments" → tick `pypi` → "Approve
   and deploy". The job runs `node tools/release/pypi-release.mjs build` (the
   same `uv build` + wheel-contents check + `twine check` as
   `npm run release:pypi:build` locally) and then `uv publish
   --trusted-publishing always`; a re-run after a partial upload skips the
   file PyPI already holds (`--check-url`). Verify with
   `pip index versions openreceive` or https://pypi.org/project/openreceive/.
   If the workflow cannot run, `UV_PUBLISH_TOKEN=<api token> npm run
   release:pypi:publish` is the manual fallback (clean tree, runs
   `test:python` first).

7c. Approve the Composer publish the same way. `Publish Composer` waits at
   the `packagist` environment; on its run page "Review deployments" → tick
   `packagist` → "Approve and deploy". The job runs
   `node tools/release/composer-release.mjs build` (the same `git subtree
   split` per package, the Laravel `composer.json` fix-up that strips the
   monorepo's path repository, and the root-`composer.json` / `Version.php`
   checks as `npm run release:composer:build` locally), then force-pushes each
   split to its repository's `main` and the commit as tag `v<x.y.z>`, and polls
   packagist.org until both packages list the version. Verify with
   `composer show -a openreceive/openreceive` or
   https://packagist.org/packages/openreceive/openreceive. If the workflow
   cannot run, `npm run release:composer:publish` is the manual fallback from a
   machine whose `composer-openreceive` / `composer-laravel` git remotes (or
   `--remote-<pkg>` URLs) can push to the split repositories; it needs a clean
   tree and waits for Packagist the same way.

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
     .release/npm/<x.y.z>/tarballs/*.tgz .release/gems/<x.y.z>/published/*.gem \
     dist/standalone-checkout-<x.y.z>.tar.gz
   ```

   `dist/standalone-checkout-<x.y.z>.tar.gz` is the bundler-less checkout
   build (`@openreceive/elements/dist/standalone`, written by
   `npm run build:packages`, gated by `npm run check:standalone`). It is the
   download the WordPress, Django and plain PHP hosts are pointed at, so a
   release without it is incomplete.

   `gem fetch` can lag the push by a minute while the index catches up; retry
   rather than fall back to a local build.

10. Verify from outside the workspace:

    ```sh
    cd "$(mktemp -d)"
    npm view @openreceive/core version
    gem list -r -e openreceive -e openreceive-server -e openreceive-rails
    pip index versions openreceive
    gh release view v<x.y.z>     # 18 assets: 14 tarballs + 3 gems + the standalone checkout
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

## PyPI Track

`npm run release:pypi:plan` is read-only and reports `_version.py` drift
against the workspace version (in PEP 440: a prerelease `0.5.0-alpha.1` is
`0.5.0a1` on PyPI, in the wheel filename and in `pip install
openreceive==0.5.0a1`; unknown prerelease labels are refused rather than
guessed). `npm run release:pypi:build` builds the sdist and wheel under
`.release/pypi/<version>` with `uv build`, asserts the wheel carries the CLI,
the FastAPI binding, the Django migrations and the standalone checkout build
(`unzip -l` — hatchling needs an explicit include for package data, and a
broken include ships silently), and runs `twine check --strict`. CI runs the
same script inside `publish-pypi.yml`, so the uploaded files are what the
build check saw. The wheel is pure Python; `coincurve` and `cryptography`
bring their own binary wheels.

## Composer Track

The two Composer packages release in lockstep with the npm workspace version:
`release:prepare` writes `OpenReceive\Version::VERSION`
(`packages/php/openreceive/src/Version.php`) and the Laravel adapter's
`"openreceive/openreceive": "~X.Y.Z"` constraint, and `npm run check:release`
fails on any drift. Neither `composer.json` carries a `version` field —
Packagist versions from tags on the split repositories.

`npm run release:composer:plan` is read-only: versions, constraints, whether
each package directory is committed (a split needs history) and where each
split would be pushed. `npm run release:composer:build` creates one branch
per package (`release/composer/<pkg>/<version>`, metadata under
`.release/composer/<version>/`) with `git subtree split`; the Laravel branch
gains one commit that strips the monorepo's `path` repository and pins the
engine to `~X.Y.Z`, so what Packagist sees never points into this checkout.
That fix-up uses a fixed release identity and the split commit's timestamp, so
rebuilding the same release reproduces the same commit and immutable tag.
`--snapshot` builds the same tree from the working tree for a dry run before
the packages are committed. Both `build` and `publish` assert the split root
carries `composer.json` for the right package with no `path` repository and no
`version` field.

The checkout UI is not in either Composer package (D2 in the frameworks plan):
plain-PHP hosts unpack `dist/standalone-checkout-<x.y.z>.tar.gz` from the
GitHub release, Laravel hosts install `@openreceive/elements` from npm.

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
- The Python `_version.py` matches the workspace version (PEP 440) and `npm run release:pypi:build` passes.
- JSON schemas and test vectors pass.
- OpenAPI and AsyncAPI validation passes through `npm run validate`.
- Secret scan passes.
- Workflow safety validation passes through `npm run check:workflows`.
- Package artifact dry run passes through `npm run build:packages`.
- Local package artifact smoke passes.
- Demo build passes.
- Live wallet smoke passes when a trusted `NWC_URI` is available in the environment.

## Faster local verification

`npm run test:ci` retains every check. After the core gate and the shared
package build, it runs Ruby, Python, PHP, .NET and the ordered
artifact/demo lane concurrently, with at most four lanes by default. Each
lane prints its duration and a separate log path; any failure fails the gate.
Set `OPENRECEIVE_CI_JOBS=1` for a serial run or raise it to `5` to run all five
lanes together. The .NET lane uses Docker's assigned CPU and memory budget.

Do not overlap package smoke with package builds: both rewrite `dist/`.
Python's package hook needs the completed standalone build. The standalone
parity check runs after Python refreshes its vendored copy. The artifact lane
keeps demo builds, bundle scans and docs generation in order. JavaScript test
files already run concurrently through Node's test runner; CI already splits
language engines into separate jobs. Reuse the successful CI and Release Dry
Run results on the exact release commit when publishing, as the publisher
already does, instead of weakening or skipping release coverage.

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
- `.github/workflows/publish-composer.yml` pushes the two Composer splits and
  their `v*` tag to the read-only split repositories Packagist watches, gated
  by the `packagist` environment's required approval; it is the only workflow
  allowed to run `composer-release.mjs publish`.
- `.github/workflows/publish-pypi.yml` publishes the Python distribution on a
  `v*` tag through PyPI Trusted Publishing (`uv publish --trusted-publishing
  always`), gated by the `pypi` environment's required approval. It is the
  only workflow allowed to run `uv publish`.

`npm run check:workflows` requires read-only workflow permissions, expected
commands, SHA-pinned actions, concurrency groups, and that `gem push` appears
only in the gem publish workflow (jobs in the `rubygems` environment) and
`uv publish` only in the PyPI publish workflow (jobs in the `pypi`
environment), each with exactly `contents: read` + `id-token: write`.

## Tagging

Tag the prepared release commit once, as `v0.4.5`. Per-package tags are
deliberately not used while every package and gem releases in lockstep with the
workspace version. Introduce per-package tags only if versions ever diverge,
after the contract is stable enough to avoid confusing SDK consumers.

## Notes

Release notes should name which examples were rebuilt, which package versions
they run, and whether the live wallet smoke was skipped or paid manually.

Do not publish npm tarballs from automation: npm publishing stays on the
maintainer's machine, while RubyGems, PyPI and Composer publishing use their protected workflows.
Do not expand new SDKs, framework adapters, React default UI, provider-data
variants, or generated models unless the shared contract and conformance gate
cover the behavior they expose.
