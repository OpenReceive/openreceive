# openreceive

**Bitcoin Lightning payments for Ruby. Your app, your wallet.**

[OpenReceive](https://openreceive.org) helps you accept payments directly into
a wallet you control. Keep your orders, prices, and fulfillment in your own
application, with receive-only Nostr Wallet Connect (NWC) connecting your
server to your wallet.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

This gem is the lightweight Ruby foundation: exact money conversion, exchange
rates, wallet adapters, and shared settlement rules, with no database
dependency. Most applications should start with one of the integrations
built on it:

- [`openreceive-rails`](https://rubygems.org/gems/openreceive-rails) — the
  complete Rails integration, with payment storage in your existing database,
  reconciliation, and three application hooks. [Start with Rails](https://github.com/OpenReceive/openreceive/blob/master/docs/guides/quickstart-rails.md).
- [`openreceive-server`](https://rubygems.org/gems/openreceive-server) — invoice
  creation, payment checks, and a Rack handler for custom Ruby integrations
  that provide their own payment persistence. [Explore the server gem](https://github.com/OpenReceive/openreceive/blob/master/packages/ruby/openreceive-server/README.md).

## Install

Requires Ruby 3.2 or later. Choose this gem directly when you need the payment
primitives rather than a mounted checkout integration.

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
  Settlement requires `settled_at` or state `settled`; a preimage alone does
  not settle a payment.
- The built-in price feed (`OpenReceive::Rates`): a static provider and the
  cached live feed with primary/fallback failover, fail-closed windows, and
  the shared currency list.
- Swap-address checksum validation (`OpenReceive::SwapAddress`): refund and
  deposit addresses are checksum-verified, never shape-guessed.
- `OpenReceive::NwcRubyReceiveClient`, a thin adapter over a host-supplied
  `nwc-ruby` client, including the optional NWC-02 notification subscription
  (`subscribe_notifications`, forwarded to that gem's
  `subscribe_to_notifications`).

Money, wallet normalization, and settlement rules are tested against shared
cross-language vectors in `spec/test-vectors`.

## Links

- Rails quickstart: [Add checkout to your app](https://github.com/OpenReceive/openreceive/blob/master/docs/guides/quickstart-rails.md)
- API reference: [Ruby and Rails APIs](https://github.com/OpenReceive/openreceive/blob/master/docs/guides/api-reference.md)
- Website: <https://openreceive.org>
- Source: <https://github.com/openreceive/openreceive>
- Changelog: [CHANGELOG.md](CHANGELOG.md)

MIT license.
