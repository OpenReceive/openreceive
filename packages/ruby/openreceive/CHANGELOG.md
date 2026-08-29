# Changelog

## 0.3.2 - 2026-08-29

No changes to this gem in 0.3.2. The release is the overpaid-deposit refund
mapping in `openreceive-server` and the browser packages' `resumePaymentHash`
resume path; this gem's wallet, invoice and settlement code is byte-identical to
0.3.1 and ships to keep the one-version-for-everything rule.

## 0.3.1 - 2026-08-28

No changes to this gem in 0.3.1. The release is the browser/React `resumable`
prop, the lazy packaged-asset URL tables, and `openreceive-rails`'s doctor task
and allow-all warning; this gem's wallet, invoice and settlement code is
byte-identical to 0.3.0 and ships to keep the one-version-for-everything rule.
The full release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md).

## 0.3.0 - 2026-08-26

No changes to this gem in 0.3.0. The release is the JavaScript integration
surface plus the order-description support in `openreceive-server` and
`openreceive-rails`; the core gem's wallet, invoice and settlement code is
byte-identical to 0.2.4 and ships to keep the one-version-for-everything rule.
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

- No functional change; released in lockstep.

## 0.2.2 - 2026-08-25

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

- No functional change; released in lockstep. The `nwc-ruby` adapter shipped
  here (`OpenReceive::NwcRubyReceiveClient`) is now covered by a test that
  drives the real gem rather than a fake, through `openreceive-rails`'
  new runtime dependency on it.

## 0.2.1 - 2026-08-24

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

- Packaging only: `npm run release:gem:build` now names the built `.gem` with
  the version RubyGems actually mints, so prerelease versions build and push.

## 0.1.1 - 2026-08-18

- First packaged release of the `openreceive` core gem: exact-money helpers,
  NWC URI parsing/redaction, wallet-error normalization, transaction
  normalization, and settlement-authority primitives.
- Built-in price feed (`OpenReceive::Rates`): static provider and cached live
  feed with primary/fallback failover and the shared 46-currency list.
- Swap-address validation helpers (`OpenReceive::SwapAddress`).
- `OpenReceive::NwcRubyReceiveClient` adapts NIP-47 params to the shape the
  wrapped client declares, by introspecting it: a positional request hash, a
  `**rest` client, or exact keyword names — including nwc-ruby's `until_ts`
  for the NIP-47 `until` scan window. A param the client cannot express raises
  and names itself instead of failing as "wrong number of arguments".
- `OpenReceive::NwcRubyReceiveClient#subscribe_notifications`: optional NWC-02
  notifications forwarded to `nwc-ruby`'s `subscribe_to_notifications`, with
  the yielded notification object translated back to the NWC-02 wire payload.
  The adapter reports the capability of the client it wraps, so a client that
  cannot notify still gets `listen_for_notifications!`'s "keep polling" error.
