# openreceive/openreceive

The [OpenReceive](https://openreceive.org) engine for PHP: receive-only
Bitcoin Lightning checkout inside your own application and database. Your
server creates and verifies BOLT11 invoices through a wallet you control via a
receive-only Nostr Wallet Connect (NWC / NIP-47) connection; the package owns
exact money, settlement, the `openreceive_payments` repository over PDO, swaps,
rates and a PSR-15 handler you dispatch to from any front controller. It never
owns orders, users, prices or fulfillment — a `Host` with three methods is the
whole bridge.

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
