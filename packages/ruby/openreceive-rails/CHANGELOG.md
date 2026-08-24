# Changelog

## 0.2.1 - Unreleased

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
