# Changelog

## 0.3.0 - 2026-08-26

### The order description rides the prepare and create responses

What the payer is BUYING, in the host's own words. When the resolver answers
with a `description` beside the amount, the handler echoes it on
`POST /checkouts/prepare` and on `POST /checkouts` — as a SIBLING of `checkout`,
not a field inside it, because the `Checkout` object is shared with the swap
responses. It is never read from a request body: the payer does not write the
copy next to the amount. Blank and non-string values are treated as absent.

Golden vectors 16 and 17 pin both responses, so the Ruby and JavaScript engines
cannot drift on the shape.

The full release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md).

## 0.2.4 - 2026-08-26

No Ruby changes in this release. 0.2.4 is browser-side only —
`@openreceive/browser`, `@openreceive/elements`, `@openreceive/react` and
`@openreceive/provider-data`. This gem is byte-identical to 0.2.3 and ships to
keep the one-version-for-everything rule, so the engine, the HTTP contract and
the settlement path are unchanged. The full release narrative lives in the
repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md).

## 0.2.3 - 2026-08-25

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

- **`POST /checkouts` now echoes `payment_methods`** (HTTP contract 0.4.1),
  amount-aware against the minted attempt's own invoice amount and served on
  the re-fetch path too. `prepare` and `payments/check` already did; the mint
  alone did not, so any client without a library-side merge lost its pay-in
  catalog the moment it minted Lightning.

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
