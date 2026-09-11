# openreceive/openreceive

Accept Bitcoin Lightning payments in your PHP application, directly into a
wallet you control. [OpenReceive](https://openreceive.org) handles invoices,
payment attempts, and settlement reconciliation in your existing database.
Keep your orders, users, prices, and fulfillment in your own code.

Use a PDO database handle and a `Host` with three methods: `authorize`,
`amountFor`, and `onPaid`. Dispatch the PSR-15 handler from any front controller,
or use the Laravel adapter for framework integration.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

## Install

Requires PHP ≥ 8.2 (64-bit) with `ext-gmp` (the NWC transport signs every
request with it), `ext-sodium`, `ext-mbstring`, `ext-json`, `ext-pdo` and one
PDO driver.

```sh
composer require openreceive/openreceive
```

- Plain PHP: [the PHP quickstart](https://openreceive.org/guides/quickstart-php)
- Laravel: [`openreceive/laravel`](https://packagist.org/packages/openreceive/laravel),
  the thin adapter over this package
- The checkout UI ships separately as `standalone-checkout-<version>.tar.gz` on
  every [GitHub release](https://github.com/OpenReceive/openreceive/releases)
  (Packagist installs from git and cannot run a JS build)
- Testing without a wallet: `OpenReceive\Testing\FakeWallet` and
  `FakeSwapProvider` — [host testing](https://openreceive.org/guides/host-testing)

Source, issues and the full documentation:
https://github.com/OpenReceive/openreceive. MIT License.
