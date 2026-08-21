# Changelog

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

## 0.1.1 - Unreleased

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
