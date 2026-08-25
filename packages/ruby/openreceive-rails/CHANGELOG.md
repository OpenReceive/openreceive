# Changelog

## 0.2.3 - 2026-08-25

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

- The mounted engine inherits `openreceive-server`'s `POST /checkouts` change:
  the response now carries `payment_methods` alongside `checkout` (HTTP
  contract 0.4.1). No configuration change; hosts using `@openreceive/browser`
  see no difference.

## 0.2.2 - 2026-08-25

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

- **Fixed: the generated migration would not load.** `openreceive:install` wrote
  `class CreateOpenreceiveTables`, but the engine's own acronym inflection makes
  Rails resolve the file name to `CreateOpenReceiveTables`, so
  `bin/rails db:migrate` failed with `NameError` on every install. The template
  declares the class Rails looks for, and a new generator test registers the
  acronym and runs the migration for real.
- **`nwc-ruby` is now a runtime dependency.** Building the client from `NWC_URI`
  is this gem's DEFAULT wallet path, so installing only `openreceive-rails`
  used to boot fine and then 500 on the first checkout with
  `Install nwc-ruby or configure nwc_client.` `config.nwc_client` remains the
  override for hosts bringing their own client.
- **Fixed: the boot preflight failed `assets:precompile`.** An image build is a
  production boot with no wallet secrets mounted, so the eager preflight failed
  the build rather than the deploy. Asset builds are now detected
  (`SECRET_KEY_BASE_DUMMY`, or an `assets:precompile`/`clean`/`clobber` rake
  invocation) and skipped with a log line.
- **Added `config.eager_preflight`** (default `true`) — the supported opt-out
  for any other boot that must come up without wallet secrets. It disables the
  BOOT check only; the wallet is still checked on the first request, and a real
  production boot with no `NWC_URI` still fails closed.
- The generated migration's `payment_hash` check constraint hoists its adapter
  branch to a local, so the first file a developer opens after running the
  generator reads as ordinary Ruby.

## 0.2.1 - 2026-08-24

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

- Packaging only: `npm run release:gem:build` now names the built `.gem` with
  the version RubyGems actually mints, so prerelease versions build and push.

## 0.1.1 - 2026-08-18

- First packaged release of `openreceive-rails`: the mountable engine, the
  engine-owned `OpenReceivePayment` model and reconciliation, and the
  `openreceive:install` generator.
- `config.price_provider` defaults to the built-in live price feed, and swap
  providers auto-build from `LSC_URI_PRIMARY`/`LSC_URI_BACKUP` — matching the
  Node engine's `createOpenReceive` defaults.
