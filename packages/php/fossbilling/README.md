# OpenReceive for FOSSBilling

Take Bitcoin Lightning payments on [FOSSBilling](https://fossbilling.org)
invoices, straight into your own wallet. The client picks the payment method on
FOSSBilling's own invoice page, and the invoice turns paid as with any other
gateway.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

FOSSBilling owns clients, invoices, prices and services. The extension bundles
the OpenReceive PHP engine, which keeps payment attempts in two tables of
FOSSBilling's own database. A settled payment is recorded the way FOSSBilling's
own gateways record one: a transaction in its payment log, the amount on the
client's balance, and the invoice paid from that balance.

Docs and setup: [FOSSBilling quickstart](https://openreceive.org/guides/quickstart-fossbilling)

## Install

Requires FOSSBilling 0.8+, 64-bit PHP 8.3+ with GMP and sodium, and FOSSBilling's
MySQL or MariaDB database. FOSSBilling's official Docker image lacks GMP; the
quickstart has the two-line Dockerfile that adds it.

Each GitHub release attaches `openreceive-fossbilling-<version>.zip`. Unzip it
in FOSSBilling's folder, the one that holds `console.php`. It adds two folders:
`modules/Openreceive` (the module: settings, routes, console commands and the
cron hook) and `library/Payment/Adapter/OpenReceive` (the payment gateway).
The release also attaches `openreceive-fossbilling-module-<version>.zip`, the
module alone with its files at the top: the package FOSSBilling's extension
directory unpacks into `modules/Openreceive`.

Then activate **OpenReceive** under **Extensions** in the admin area, and save
the receive-only NWC code on its settings page. Activating writes the payment
gateway into `library/Payment/Adapter/OpenReceive` from the module's own copy,
so the module-only ZIP needs nothing else. Or, as the web server's user:

```sh
php console.php openreceive:configure --nwc-uri=- < /path/to/code-file
php console.php openreceive:doctor
```

The console commands appear once the module is active. The source directory is
not an installable extension: the release ZIP bundles the dependencies,
prefixed inside `vendor.phar`, and the checkout's script.

## Commands

- `openreceive:configure --nwc-uri=-` (or `--lsc-uri-primary=-`) saves a code
  read from stdin, encrypted, after the wallet answers as receive-only, and
  turns the payment method on.
- `openreceive:doctor` checks the install and prints each code as set or unset.
- `openreceive:test-invoice <invoice id>`, or `--new`, makes a Lightning invoice
  through the payment page's own route.
- `openreceive:reconcile` runs one settlement pass. Every FOSSBilling cron run
  runs one.

## Build

From the repository root, with Node 22+, PHP 8.3+ with GMP and sodium, and
Composer:

```sh
npm ci
npm run build:packages
composer install --working-dir=packages/php/fossbilling
npm run release:fossbilling:build
```

The results are `dist/openreceive-fossbilling-<version>.zip` and
`dist/openreceive-fossbilling-module-<version>.zip`.

Part of [OpenReceive](https://openreceive.org). MIT licensed.
