# Changelog

## 0.2.2 - 2026-08-25

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

- No functional change. `nwc-ruby` is still deliberately NOT a dependency of
  this gem: a Rack host injects its own NWC client and this gem never reaches
  for one. The Rails engine — the exception that rationale already named — now
  declares it, and the comment here says so.

## 0.2.1 - 2026-08-24

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

- Packaging only: `npm run release:gem:build` now names the built `.gem` with
  the version RubyGems actually mints, so prerelease versions build and push.

## 0.1.1 - 2026-08-18

- First packaged release of `openreceive-server`: the storage-free Service
  mirroring the Node engine and the framework-agnostic Rack app implementing
  the shipped HTTP routes.
- FixedFloat swap provider with LSC auto-wiring
  (`LSC_URI_PRIMARY`/`LSC_URI_BACKUP`), amount-aware swap options, and
  primary/backup failover; the Service defaults to the built-in live price
  feed when the host injects no provider.
- `payments/check` whitelists public transaction fields (preimage/invoice
  never reach the payer); 405/503/500 wire parity with the Node engine; the
  rate limiter buckets IPv6 clients by /64.
