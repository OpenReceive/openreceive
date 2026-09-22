# Release Process

These packages make up the general release. They all share one version number:

- OpenReceive `0.4.11`
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
- PyPI: `openreceive` (`packages/python/openreceive`). Its `_version.py` holds
  the PEP 440 form of the workspace version, so `0.5.0-alpha.1` becomes `0.5.0a1`.
- Packagist: `openreceive/openreceive` (`packages/php/openreceive`) and
  `openreceive/laravel` (`packages/php/laravel`). The engine's version lives in
  `src/Version.php`, not in `composer.json`, because Packagist reads versions
  from tags. The Laravel package pins the engine with `~X.Y.Z`. Each package is
  published through its own read-only split repository.

Public package manifests are public while testkit stays private. The public
packages are:

- the unscoped `openreceive` CLI package, a bin that forwards to `@openreceive/node`
- the Node service package
- the shipped HTTP route handler, `@openreceive/http`
- its framework adapters: `@openreceive/express`, `@openreceive/fastify` and
  `@openreceive/next`
- core contracts and helpers, browser checkout helpers, provider-data assets,
  elements, and the frontend adapters

The root workspace and `@openreceive/testkit` stay private.

The BTCPay Server plugin is released separately. A general release does not
change its source version, does not submit Plugin Builder builds, and does not
publish the plugin. A bump to the plugin's source version is not a request to
publish it. Submit or publish a BTCPay build only when the maintainer explicitly
asks for a BTCPay release.

Five registries, five publishers:

| Registry | Who publishes | Credential |
| --- | --- | --- |
| npm (14 packages) | the maintainer's machine, `npm run release:publish` | granular token with "Bypass 2FA", loaded from `.env.release` |
| RubyGems (3 gems) | GitHub Actions, `.github/workflows/publish-gems.yml` | none stored: OIDC Trusted Publishing, approved per run in the `rubygems` environment |
| PyPI (1 distribution) | GitHub Actions, `.github/workflows/publish-pypi.yml` | none stored: OIDC Trusted Publishing, approved per run in the `pypi` environment |
| Packagist (2 packages) | GitHub Actions, `.github/workflows/publish-composer.yml`. It pushes the split repositories that Packagist watches. | separate write-enabled deploy keys: `COMPOSER_OPENRECEIVE_SSH_KEY` for `OpenReceive/openreceive-php`, `COMPOSER_LARAVEL_SSH_KEY` for `OpenReceive/openreceive-laravel`, both in the protected `packagist` environment |
| GitHub release | the maintainer's machine, `gh release create` | `gh` login for the OpenReceive account (`GH_CONFIG_DIR` from `.env.release`) |

## One-time setup

Each release path needs accounts and environments set up once. Check the
registry and GitHub settings before the first release. Workflow files cannot
create accounts or enforce environment reviewer settings.

- `.env.release` sits at the repo root and is gitignored. It exports the npm
  userconfig, the `gh` config directory and `GH_REPO` for the OpenReceive
  identity. It also exports a push-scoped `GEM_HOST_API_KEY`, which only the
  manual gem fallback uses. Source it first in every release shell.
- On rubygems.org, each of the three gems has one entry under "Trusted
  publishers" with these values:
  - repository owner `OpenReceive` (case-sensitive)
  - repository `openreceive`
  - workflow filename `publish-gems.yml`
  - environment `rubygems`

  RubyGems checks these values against the claims in the OIDC token. They must
  name the real repository, not a fork.
- On GitHub, the `rubygems` environment has a required reviewer. It does not
  let administrators bypass the review, and it admits only `v*` tags. That
  approval click is the only thing between "someone pushed a tag" and "gems
  published". Any edit to `publish-gems.yml` changes that trust boundary.
- Every gemspec sets `rubygems_mfa_required`. The RubyGems account keeps MFA at
  "UI and API". A trusted-publisher key satisfies both, so CI needs no change
  there.
- On pypi.org, the `openreceive` project has one "Trusted publisher": owner
  `OpenReceive`, repository `openreceive`, workflow `publish-pypi.yml`,
  environment `pypi`. On GitHub, the `pypi` environment is set up like
  `rubygems`: a required reviewer, no administrator bypass, and `v*` tags only.
  Before the first upload exists, create the entry on PyPI as a "pending
  publisher" with the same four values. The first approved run claims the name.
- Packagist has no upload API and cannot read a monorepo. So each Composer
  package lives in its own read-only split repository:
  `OpenReceive/openreceive-php` for `openreceive/openreceive`, and
  `OpenReceive/openreceive-laravel` for `openreceive/laravel`. Each is
  registered on packagist.org with the Packagist GitHub App (or its webhook),
  so pushed tags become versions. To set this up:
  1. Create a [Packagist account](https://packagist.org/register/) and the two
     empty public repositories.
  2. Protect the `packagist` GitHub environment before adding credentials: a
     required reviewer, no administrator bypass, and `v*` tags only.
  3. Generate **two different** ed25519 key pairs without passphrases, so
     publishing can run unattended.
  4. Add each public key as a deploy key with **Allow write access** on its
     split repository.
  5. In that environment, store the engine private key as
     `COMPOSER_OPENRECEIVE_SSH_KEY` and the Laravel private key as
     `COMPOSER_LARAVEL_SSH_KEY`. [GitHub deploy keys cannot
     be reused across repositories](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys).

  The workflow picks each key through a separate SSH alias and pins GitHub's
  public host key. It removes the temporary key files when the publish step
  exits. Nobody commits to a split repository by hand. Every release
  force-pushes `main` from a fresh `git subtree split`. Version tags are
  immutable.

  For the first publication:
  1. Commit the workflow changes and prepare a new release tag.
  2. Cancel that tag's automatic **Publish Composer** run. Otherwise the
     concurrency gate queues your manual run behind it.
  3. Dispatch the workflow manually at the same tag with **bootstrap** checked,
     and approve the protected environment. Bootstrap pushes **both**
     repositories and tags with `--skip-packagist`, because neither package is
     registered yet.
  4. [Submit both populated repositories to Packagist](https://packagist.org/packages/submit)
     and enable automatic updates.
  5. Dispatch the same tag again with **bootstrap unchecked** and approve it.
     This run verifies that Packagist discovers the release.

  Later tag-triggered releases always poll Packagist. A successful bootstrap
  only confirms the split pushes. It does not confirm a public Packagist
  release.

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

   `release:prepare` rewrites all of these in lockstep:
   - every workspace `package.json` version and internal `@openreceive/*` pin
   - the Ruby gem `VERSION` constants
   - the Python `_version.py` (PEP 440)
   - the PHP `OpenReceive\Version::VERSION`
   - the Laravel package's `~X.Y.Z` constraint on the engine
   - the root and per-gem changelog headings (`## <x.y.z> - Unreleased`)
   - the path-gem `Gemfile.lock` of the Rails example
   - the version references in this document
   - the package lock

   Nothing else is hand-edited for a bump.

3. Regenerate the version-stamped docs. `release:prepare` does not do this.
   If you skip it, `check:docs` fails on each stale file:

   ```sh
   npm run build:docs
   ```

4. Write the release notes under `## <x.y.z> - Unreleased` in `CHANGELOG.md`
   and in each gem's `CHANGELOG.md`. Prepare inserts the empty sections. If the
   root changelog already had a bare `## Unreleased` section, merge it into the
   versioned heading. Keep the heading text exact: `release:stamp` and
   `check:release` both match it literally. Then run:

   ```sh
   npm run check:release
   ```

5. The full gate must pass on the exact release commit, as shown below. Run
   focused checks while you prepare changes. Then commit and run the full gate
   once. If a fix changes the commit, run the gate again on the corrected commit
   before tagging. A red gate stops publication.

6. Date the headings and commit. Run the full gate on that exact commit. Then
   create the new tag and push:

   ```sh
   npm run release:stamp -- --version <x.y.z>   # must report 4 changelogs
   git add -A && git commit -m "release: v<x.y.z>"
   npm run test:ci
   git diff --exit-code && test -z "$(git status --porcelain)"
   git tag -a v<x.y.z> -m "OpenReceive v<x.y.z>"
   git push origin master && git push origin v<x.y.z>
   ```

   The push starts five workflows: `CI` on master, and `Release Dry Run`,
   `Publish Gems`, `Publish PyPI` and `Publish Composer` on the tag. If the tag
   does not match `package.json`, `Release Dry Run` fails first.

   **Hand over the approval URLs right now**, before anything else. All three
   publish workflows stop at their environment until a human approves them. The
   release is stalled until that click. Print the URLs and give them to the
   maintainer as a release step, not a footnote:

   ```sh
   gh run list --workflow publish-gems.yml -L 1 --json url,status --jq '.[0] | "\(.status) \(.url)"'
   gh run list --workflow publish-pypi.yml -L 1 --json url,status --jq '.[0] | "\(.status) \(.url)"'
   gh run list --workflow publish-composer.yml -L 1 --json url,status --jq '.[0] | "\(.status) \(.url)"'
   ```

7. Approve the gem publish. `Publish Gems` stops at the `rubygems` environment
   until a required reviewer approves it in the browser. The approval cannot be
   scripted from this machine. Print the run's URL and hand it to the
   maintainer straight away. The gems wait on that click, and so does the
   GitHub release, which needs the published gems. Whoever runs the release,
   person or agent, reports this URL as a release step, not as a footnote:

   ```sh
   gh run list --workflow publish-gems.yml -L 1 --json url,status --jq '.[0] | "\(.status) \(.url)"'
   ```

   The URL looks like `https://github.com/OpenReceive/openreceive/actions/runs/<id>`.
   It shows "waiting" until approved. On that page, click "Review deployments",
   tick `rubygems`, then click "Approve and deploy". The job then:
   - builds the three gems in a `ruby:3.4` container
   - exchanges its OIDC token for a 15-minute push-only key
   - pushes `openreceive`, `openreceive-server` and `openreceive-rails`, in
     that order. The order matters because sibling gems are exact-pinned.

   If a push stops partway, a re-run skips whatever already landed.

   ```sh
   gh run watch   # or: gh run list --workflow publish-gems.yml -L 1
   ```

7b. Approve the PyPI publish the same way. `Publish PyPI` waits at the `pypi`
   environment. On its run page, click "Review deployments", tick `pypi`, then
   click "Approve and deploy". The job runs
   `node tools/release/pypi-release.mjs build`. That is the same `uv build`,
   wheel-contents check and `twine check` as `npm run release:pypi:build` runs
   locally. The job then runs `uv publish --trusted-publishing always`. If an
   upload stops partway, a re-run skips the file PyPI already holds
   (`--check-url`). Verify with `pip index versions openreceive` or
   https://pypi.org/project/openreceive/. If the workflow cannot run, the
   manual fallback is `UV_PUBLISH_TOKEN=<api token> npm run
   release:pypi:publish`. It needs a clean tree and runs `test:python` first.

7c. Approve the Composer publish the same way. `Publish Composer` waits at the
   `packagist` environment. On its run page, click "Review deployments", tick
   `packagist`, then click "Approve and deploy". The job runs
   `node tools/release/composer-release.mjs build`, which does the same work as
   `npm run release:composer:build` locally:
   - one `git subtree split` per package
   - the Laravel `composer.json` fix-up that strips the monorepo's path
     repository
   - the root-`composer.json` and `Version.php` checks

   The job then force-pushes each split to its repository's `main`, pushes the
   commit as tag `v<x.y.z>`, and polls packagist.org until both packages list
   the version. Verify with `composer show -a openreceive/openreceive` or
   https://packagist.org/packages/openreceive/openreceive. If the workflow
   cannot run, the manual fallback is `npm run release:composer:publish`. Run
   it from a machine that can push to the split repositories through its
   `composer-openreceive` / `composer-laravel` git remotes (or `--remote-<pkg>`
   URLs). It needs a clean tree and waits for Packagist the same way.

8. Publish to npm once `CI` and `Release Dry Run` are green on the release
   commit. Rehearse first:

   ```sh
   npm run release:publish -- --tag latest --dry-run
   npm run release:publish -- --tag latest
   ```

   If both workflows are green on the exact commit and the worktree is clean,
   the script does not re-run `npm run test:ci`. Together the two workflows run
   every step of it. Otherwise, or without `gh`, the script runs the suite
   locally. `--skip-tests` skips it unconditionally. The script builds exact
   tarballs under `.release/npm/<version>/tarballs`, skips versions already on
   npm, and publishes only the public package family. Pass `--otp <code>` only
   on a machine whose npm account still has a TOTP authenticator. The
   OpenReceive account uses a bypass-2FA token instead.

9. Cut the GitHub release with the notes and the exact artifacts. Take the gems
   from RubyGems, because CI built them and a local build has different bytes:

   ```sh
   mkdir -p .release/gems/<x.y.z>/published && (cd .release/gems/<x.y.z>/published &&
     for g in openreceive openreceive-server openreceive-rails; do gem fetch "$g" -v <x.y.z>; done)
   gh release create v<x.y.z> --title "OpenReceive v<x.y.z>" \
     --notes-file <(awk '/^## <x.y.z> - /{f=1;next}/^## /{f=0}f' CHANGELOG.md) \
     .release/npm/<x.y.z>/tarballs/*.tgz .release/gems/<x.y.z>/published/*.gem \
     dist/standalone-checkout-<x.y.z>.tar.gz
   ```

   `dist/standalone-checkout-<x.y.z>.tar.gz` is the checkout build for hosts
   without a bundler (`@openreceive/elements/dist/standalone`).
   `npm run build:packages` writes it and `npm run check:standalone` gates it.
   WordPress, Django and plain PHP hosts download it, so a release without it
   is incomplete.

   `gem fetch` can lag the push by a minute while the index catches up. Retry
   rather than fall back to a local build.

10. Verify from outside the workspace:

    ```sh
    cd "$(mktemp -d)"
    npm view @openreceive/core version
    gem list -r -e openreceive -e openreceive-server -e openreceive-rails
    pip index versions openreceive
    gh release view v<x.y.z>     # 18 assets: 14 tarballs + 3 gems + the standalone checkout
    ```

11. Redeploy openreceive.org with this release's docs bundle. In the site repo,
    run `bin/rails docs:sync`, then the JS build, then deploy. Until then the
    public site serves the previous release's guides and footer version.

## RubyGems Track

The gems release in lockstep with the npm workspace version. `release:prepare`
bumps their `VERSION` constants and changelog headings. `npm run
check:release` fails on any drift. Sibling gem dependencies are exact-pinned
through the shared `VERSION` constant, so gemspecs need no manual edits.

- `npm run release:gem:plan` is read-only and reports version drift.
- `npm run release:gem:build` builds the three `.gem` artifacts locally under
  `.release/gems/<version>`. CI also builds them with
  `./tools/ci/ruby-gem-build.sh` on every push and PR.

RubyGems rewrites prerelease versions. A workspace version of `0.2.0-alpha.0`
becomes `0.2.0.pre.alpha.0`, both in the artifact filename and in what
rubygems.org reports. So the artifact directory is named for the workspace
version, while the files inside carry the RubyGems form. `gem install` needs
`--pre` to select a prerelease.

If `publish-gems.yml` cannot run, the manual fallback is
`tools/release/push-gems.sh --otp <code>`. It:
- sources `.env.release` and proves the API key answers
- builds any missing artifact before asking for a code
- pushes the local build, with one fresh TOTP code per gem
- confirms by checksum that each gem landed

It is safe to re-run after a half-finished push.

Publish the npm packages and the gems from the same prepared commit, so both
registries carry identical versions.

## PyPI Track

`npm run release:pypi:plan` is read-only. It reports drift between
`_version.py` and the workspace version. Versions use PEP 440: a prerelease
`0.5.0-alpha.1` is `0.5.0a1` on PyPI, in the wheel filename and in `pip install
openreceive==0.5.0a1`. The script refuses unknown prerelease labels rather than
guessing.

`npm run release:pypi:build` builds the sdist and wheel under
`.release/pypi/<version>` with `uv build`. It then:
- asserts with `unzip -l` that the wheel carries the CLI, the FastAPI binding,
  the Django migrations and the standalone checkout build. Hatchling needs an
  explicit include for package data, and a broken include ships silently.
- runs `twine check --strict`

CI runs the same script inside `publish-pypi.yml`, so the uploaded files are
the ones the build check saw. The wheel is pure Python. `coincurve` and
`cryptography` bring their own binary wheels.

## Composer Track

The two Composer packages release in lockstep with the npm workspace version.
`release:prepare` writes `OpenReceive\Version::VERSION`
(`packages/php/openreceive/src/Version.php`) and the Laravel adapter's
`"openreceive/openreceive": "~X.Y.Z"` constraint. `npm run check:release`
fails on any drift. Neither `composer.json` has a `version` field, because
Packagist takes versions from tags on the split repositories.

`npm run release:composer:plan` is read-only. It reports versions, constraints,
whether each package directory is committed (a split needs history), and where
each split would be pushed.

`npm run release:composer:build` uses `git subtree split` to create one branch
per package, `release/composer/<pkg>/<version>`, with metadata under
`.release/composer/<version>/`. The Laravel branch gets one extra commit. That
commit strips the monorepo's `path` repository and pins the engine to `~X.Y.Z`,
so nothing Packagist sees points into this checkout. The fix-up commit uses a
fixed release identity and the split commit's timestamp. Rebuilding the same
release therefore reproduces the same commit and immutable tag.

`--snapshot` builds the same tree from the working tree. Use it for a dry run
before the packages are committed. Both `build` and `publish` assert that the
split root has `composer.json` for the right package, with no `path` repository
and no `version` field.

Neither Composer package contains the checkout UI (D2 in the frameworks plan).
Plain-PHP hosts unpack `dist/standalone-checkout-<x.y.z>.tar.gz` from the
GitHub release. Laravel hosts install `@openreceive/elements` from npm.

## Release checklist

The release owner checks, before tagging:

- `npm run test:ci` is green on the release commit.
- Changelog updated.
- Agent skills describe the current public API. A release that changes the
  public API updates `skills/*/SKILL.md` in the same change. Run
  `npm run generate:skills` so the `.agents/skills/` twin and every package and
  gem copy match. `npm run check:docs` enforces the sync, not the prose.
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

Every release tag also runs **BTCPay Upstream Compatibility**, in parallel with
release readiness. It finds the newest stable upstream release and runs two
tests on the matching Docker image:
- a build against that upstream source
- the binary we built against our pinned source

A weekly run catches upstream changes between our releases. This check needs no
manual pull or submodule update. Run it locally with
`npm run test:btcpay:latest`. See the
[.NET testing guide](../../packages/dotnet/README.md#automatic-upstream-compatibility-checks).
When the npm publisher runs local tests instead of relying on green CI for the
release commit, it runs this check after `test:ci`. Ordinary development runs of
`test:ci` keep their pinned, reproducible BTCPay test dependency.

Package builds, packing, npm availability checks and publishing run up to four
jobs at once. Set `OPENRECEIVE_PACKAGE_JOBS=1` to run them one at a time, or try
`8` on a larger machine. Build and publish jobs wait for their workspace
dependencies. After a failure, no new jobs start, and the runner waits for jobs
already running to finish. Packaging builds each package once and disables the
second build that `prepack` would normally trigger. Running `npm pack` directly
still runs the package's normal build hook.

On a clean checkout, package smoke and the npm release commands share tarballs
in `.release/package-artifacts/`. A tarball is reused only when all of these
match: the Git commit, the Node and npm versions, the platform, the package
versions, and the SHA-256 checksums. Dirty trees always build fresh. The
publisher runs the import smoke against the exact archives before uploading,
even when it reuses a dry run's artifacts. Delete that cache to force a fresh
build. This reuse is local only. Separate GitHub runners build their own
artifacts. Before release verification, install dependencies from the lockfile
with `npm ci`. Do not edit source while release commands are running.

Composer publishing reuses the split commits from the preceding build. It first
verifies the source commit, the complete package tree and the Composer
metadata. PyPI and the standalone checkout use `npm run build:standalone`,
which builds only elements and its workspace dependencies. The release dry run
no longer builds every package before package smoke builds them again.

`npm run test:ci` keeps every check. It first runs the core gate and the shared
package build. Then it runs five lanes concurrently: Ruby, Python, PHP, .NET,
and the ordered artifact/demo lane. By default at most four lanes run at once.
Each lane prints its duration and a separate log path. Any failure fails the
gate. Set `OPENRECEIVE_CI_JOBS=1` for a serial run, or `5` to run all five lanes
together. The .NET lane uses the CPU and memory budget Docker assigns.

On a Mac with 16 CPU cores and 64 GB of RAM, start by setting Docker Desktop's
**Settings → Resources → Advanced** to **16 CPUs and 16 GB memory**.
Apply any resource change before running tests, because restarting Docker
interrupts containers. Package builds run on the host and use
`OPENRECEIVE_PACKAGE_JOBS`. Docker's allocation controls the container
workloads.

Some steps must not overlap:
- Do not run package smoke during package builds. Both rewrite `dist/`.
- Python's package hook needs the finished standalone build.
- The standalone parity check runs after Python refreshes its vendored copy.
- The artifact lane runs demo builds, bundle scans and docs generation in order.

JavaScript test files already run concurrently through Node's test runner, and
CI already splits language engines into separate jobs. To publish faster, reuse
the successful CI and Release Dry Run results on the exact release commit, as
the publisher already does. Do not weaken or skip release coverage.

## GitHub Workflows

- `.github/workflows/ci.yml` runs the full local gate on every push and PR.
- `.github/workflows/conformance.yml` runs contract, generated-model, JS, and
  internal testkit checks.
- `.github/workflows/demos.yml` validates and builds the Buy a Button example
  artifacts. It does not inject receive-only NWC codes.
- `.github/workflows/provider-registry.yml` validates canonical provider data.
- `.github/workflows/security.yml` runs secret and client-bundle boundary
  checks.
- `.github/workflows/release.yml` is a release dry run on every `v*` tag.
  Together with `ci.yml` it covers every `test:ci` step. `release:publish`
  relies on that to skip the local suite.
- `.github/workflows/publish-gems.yml` publishes the gems on a `v*` tag through
  RubyGems Trusted Publishing. The `rubygems` environment's required approval
  gates it. It is the only workflow allowed to run `gem push`.
- `.github/workflows/publish-composer.yml` pushes the two Composer splits and
  their `v*` tag to the read-only split repositories that Packagist watches.
  The `packagist` environment's required approval gates it. It is the only
  workflow allowed to run `composer-release.mjs publish`.
- `.github/workflows/publish-pypi.yml` publishes the Python distribution on a
  `v*` tag through PyPI Trusted Publishing (`uv publish --trusted-publishing
  always`). The `pypi` environment's required approval gates it. It is the
  only workflow allowed to run `uv publish`.

`npm run check:workflows` requires:
- read-only workflow permissions
- the expected commands
- SHA-pinned actions
- concurrency groups
- `gem push` only in the gem publish workflow (jobs in the `rubygems`
  environment), and `uv publish` only in the PyPI publish workflow (jobs in the
  `pypi` environment). Each of those jobs has exactly `contents: read` +
  `id-token: write`.

## Tagging

Tag the prepared release commit once, as `v0.4.11`. We do not use per-package
tags while the general package family releases in lockstep with the workspace
version. Add per-package tags only if versions ever diverge, and only after the
contract is stable enough that they will not confuse SDK consumers.

## Notes

Release notes should name which examples were rebuilt and which package
versions they run. They should also say whether the live wallet smoke was
skipped or paid manually.

Do not publish npm tarballs from automation. npm publishing stays on the
maintainer's machine. RubyGems, PyPI and Composer publishing use their
protected workflows.
Do not expand new SDKs, framework adapters, React default UI, provider-data
variants, or generated models unless the shared contract and conformance gate
cover the behavior they expose.
