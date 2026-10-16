# OpenReceive for Paymenter

Take Bitcoin Lightning payments on [Paymenter](https://paymenter.org) invoices,
straight into your own wallet. The client pays from Paymenter's own payment
dialog, and the invoice turns paid as with any other gateway.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

Paymenter owns clients, invoices, prices and services. The extension bundles
the OpenReceive PHP engine, which keeps payment attempts in two tables of
Paymenter's own database and records each settled payment on its invoice with
Paymenter's own payment call.

Docs and setup: [Paymenter quickstart](https://openreceive.org/guides/quickstart-paymenter)

## Install

Requires Paymenter 1.5+, 64-bit PHP 8.3+ with GMP and sodium, and MySQL or
MariaDB. Paymenter's official Docker image has all of them.

Each GitHub release attaches `openreceive-paymenter-<version>.zip`, which holds
one `OpenReceive` folder for Paymenter's `extensions/Gateways/` directory. Unzip
it there, then, as the web server's user:

```sh
php artisan app:extension:install gateway OpenReceive
printf '%s' "$NWC_CODE" | php artisan openreceive:configure --nwc-uri=-
php artisan openreceive:doctor
```

Read the code from your secret manager rather than typing it into the
command. You can also paste it in the admin area under **Gateways**. The
source directory is not an installable extension: the release ZIP bundles the
dependencies, prefixed inside `vendor.phar`, and the checkout's script.

## Commands

- `openreceive:configure --nwc-uri=-` (or `--lsc-uri-primary=-`) saves a code
  read from stdin, encrypted, after the wallet answers as receive-only.
- `openreceive:doctor` checks the install and prints each code as set or unset.
- `openreceive:test-invoice <invoice id>`, or `--new`, makes a Lightning invoice
  through the payment dialog's own route.
- `openreceive:reconcile` runs one settlement pass. Paymenter's scheduler runs
  it every minute.

## Build

From the repository root, with Node 22+, PHP 8.3+ with GMP and sodium, and
Composer:

```sh
npm ci
npm run build:packages
composer install --working-dir=packages/php/paymenter
npm run release:paymenter:build
```

The result is `dist/openreceive-paymenter-<version>.zip`.

Part of [OpenReceive](https://openreceive.org). MIT licensed.
