# Changelog

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

## 0.1.1 - Unreleased

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
