# openreceive

Pure Ruby exact-money, NWC normalization, and settlement-authority primitives
for [OpenReceive](https://openreceive.org). It has no persistence dependency.
Settlement requires `settled_at` or state `settled`; a preimage alone does not
settle a payment.

OpenReceive adds receive-only Bitcoin Lightning payments to a website or app:
your server creates and verifies BOLT11 invoices through a wallet you control
via a receive-only Nostr Wallet Connect (NWC / NIP-47) connection. This gem is
the dependency-free core; most applications want one of the gems built on it:

- [`openreceive-server`](https://rubygems.org/gems/openreceive-server) — the
  storage-free Service and framework-agnostic Rack app for the shipped HTTP
  routes.
- [`openreceive-rails`](https://rubygems.org/gems/openreceive-rails) — the
  mountable Rails engine with host-owned payment scaffolding.

## Install

```sh
gem install openreceive
```

or in a Gemfile:

```ruby
gem "openreceive"
```

## What it provides

- Exact decimal money conversion (fiat price -> msats) backed by `BigDecimal`,
  with the shared cross-language test vectors.
- NWC connection-URI parsing, validation, and redaction
  (`OpenReceive.parse_nwc_uri`, `OpenReceive.redact_nwc_uri`). Receive-only NWC
  codes never belong in browser code, logs, or examples.
- Wallet-error and transaction normalization
  (`OpenReceive::Nwc.normalize_wallet_error`,
  `OpenReceive::Nwc.normalize_transaction`).
- Settlement-authority rules: what counts as settled, and what never does.
- The built-in price feed (`OpenReceive::Rates`): a static provider and the
  cached live feed with primary/fallback failover, fail-closed windows, and
  the shared currency list.
- Swap-address checksum validation (`OpenReceive::SwapAddress`): refund and
  deposit addresses are checksum-verified, never shape-guessed.
- `OpenReceive::NwcRubyReceiveClient`, a thin adapter over a host-supplied
  `nwc-ruby` client, including the optional NWC-02 notification subscription
  (`subscribe_notifications`, forwarded to that gem's
  `subscribe_to_notifications`).

The behavior is pinned to the same test vectors as the Node engine
(`spec/test-vectors` in the repository), so both engines make identical
decisions.

## Links

- Documentation: <https://openreceive.org>
- Source: <https://github.com/openreceive/openreceive>
- Changelog: [CHANGELOG.md](CHANGELOG.md)

MIT license.
