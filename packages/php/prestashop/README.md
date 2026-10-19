# OpenReceive for PrestaShop

Take Bitcoin Lightning payments in a [PrestaShop](https://prestashop-project.org)
store, straight into your own wallet. The customer picks the payment option at
checkout and pays on PrestaShop's own order confirmation page; the order moves
to "Payment accepted" as with any other payment module.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

PrestaShop owns customers, orders, prices and carriers. The module bundles the
OpenReceive PHP engine, which keeps payment attempts in two tables of
PrestaShop's own database. A settled payment is recorded the way PrestaShop's
own payment modules record one: an order payment whose transaction id is the
payment hash, then the order's move to "Payment accepted", with its invoice
and email.

Docs and setup: [PrestaShop quickstart](https://openreceive.org/guides/quickstart-prestashop)

## Install

Requires PrestaShop 9, 64-bit PHP 8.2+ with GMP and sodium, and PrestaShop's
MySQL or MariaDB database. PrestaShop 8 runs on PHP 8.1 at most, below the
engine's floor. The official PrestaShop Docker image lacks GMP; the quickstart
has the two-line Dockerfile that adds it.

Each GitHub release attaches `openreceive-prestashop-<version>.zip`, one
`openreceive/` folder. Upload it in the back office under **Modules → Module
Manager → Upload a module**, which installs it, then open **Configure** and
save the receive-only NWC code. Or unzip it into `modules/` and, as the web
server's user:

```sh
php bin/console prestashop:module install openreceive
php bin/console openreceive:configure --nwc-uri=- < /path/to/code-file
php bin/console openreceive:doctor
```

The source directory is not an installable module: the release ZIP bundles
the dependencies, prefixed inside `vendor.phar`, and the checkout's script.

## Commands

- `openreceive:configure --nwc-uri=-` (or `--lsc-uri-primary=-`) saves a code
  read from stdin, encrypted, after the wallet answers as receive-only, and
  turns the payment option on.
- `openreceive:doctor` checks the install and prints each code as set or unset.
- `openreceive:test-invoice <order id>`, or `--new`, makes a Lightning invoice
  through the checkout's own route.
- `openreceive:reconcile` runs one settlement pass. Run it from cron every five
  minutes, for customers who leave the page before their payment settles.

## Build

From the repository root, with Node 22+, PHP 8.3+ with GMP and sodium, and
Composer:

```sh
npm ci
npm run build:packages
composer install --working-dir=packages/php/prestashop
npm run release:prestashop:build
```

This writes `dist/openreceive-prestashop-<version>.zip`.

## License

MIT
