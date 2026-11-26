# OpenReceive for HikaShop

Take Bitcoin Lightning payments in a [HikaShop](https://www.hikashop.com)
store on Joomla, straight into your own wallet. The customer picks the
payment method at checkout and pays on HikaShop's own thank-you page; the
order moves to "Confirmed" as with any other payment method. The free
HikaShop Starter edition is enough.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

HikaShop owns customers, orders, prices and shipping. The package bundles the
OpenReceive PHP engine, which keeps payment attempts in two tables of
Joomla's own database. A settled payment is recorded the way HikaShop's own
payment plugins record one: a payment entry in the order's history whose
payment id is the payment hash, then the order's move to "Confirmed", with
its invoice number and emails.

Docs and setup: [HikaShop quickstart](https://openreceive.org/guides/quickstart-hikashop)

## Install

Requires Joomla 5 or 6, HikaShop 6 (Starter, Essential or Business), 64-bit
PHP 8.2+ with GMP and sodium, and Joomla's MySQL or MariaDB database. The
official Joomla Docker images already have GMP and sodium.

Each GitHub release attaches `openreceive-hikashop-<version>.zip`, a Joomla
package with two plugins: the HikaShop payment plugin and its commands for
Joomla's console. Install it in **System → Install → Extensions**, then in
HikaShop open **System → Payment methods → New → OpenReceive**, paste the
receive-only NWC code and save. Or, from the site's folder as the web
server's user:

```sh
php cli/joomla.php extension:install --path=/path/to/openreceive-hikashop-<version>.zip
php cli/joomla.php openreceive:configure --nwc-uri=- < /path/to/code-file
php cli/joomla.php openreceive:doctor
```

The source directory is not an installable package: the release ZIP bundles
the dependencies, prefixed inside `vendor.phar`, and the checkout's script.

## Commands

- `openreceive:configure --nwc-uri=-` (or `--lsc-uri-primary=-`) saves a code
  read from stdin, encrypted, after the wallet answers as receive-only, and
  makes the HikaShop payment method.
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
composer install --working-dir=packages/php/hikashop
npm run release:hikashop:build
```

This writes `dist/openreceive-hikashop-<version>.zip`.

## License

GPL-2.0-or-later, as the Joomla Extensions Directory requires. The bundled
OpenReceive engine and its dependencies keep their own licenses (MIT, ISC or
the Unlicense), all compatible with the GPL.
