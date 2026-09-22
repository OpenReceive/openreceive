# WordPress + WooCommerce quickstart

Activate WooCommerce first. Then install the built OpenReceive plugin zip
through **Plugins → Add New → Upload Plugin**. You cannot upload the source
directory as-is. It needs a build first. The plugin is not yet submitted to
WordPress.org.

Requirements: WordPress 6.6+, WooCommerce 9+, 64-bit PHP 8.2+ with GMP and sodium,
and MySQL 8 or MariaDB 10.5+. When you activate the plugin, it creates tables for
payment attempts in your existing WordPress database. You do not need a separate
database or application.

## Get the installable archive

If the [OpenReceive GitHub release](https://github.com/OpenReceive/openreceive/releases)
you picked lists `openreceive-wordpress-<version>.zip`, use that file. The GitHub
source-code zip is not the plugin archive. If the release has no built zip yet,
build one on a development machine with Node 22+, PHP 8.2+, Composer and WP-CLI:

```sh
git clone https://github.com/OpenReceive/openreceive.git
cd openreceive
git checkout <release-tag>
npm ci
npm run build:packages
composer install --working-dir=packages/php/wordpress
npm run release:wordpress:build
```

Upload the resulting `dist/openreceive-wordpress-<version>.zip`. The build
needs WP-CLI on `PATH`. Otherwise, set `OPENRECEIVE_WP_CLI` to the absolute path
of its phar. Your WordPress server needs neither Node nor Composer. The built
plugin already bundles its dependencies and checkout assets.

## Configure the wallet

1. Open **WooCommerce → Settings → Payments → OpenReceive**.
2. Enter a receive-only NWC code and save.
3. Enable the gateway.

When you save, the plugin checks that the wallet can receive. It refuses to save
a wallet that can spend, unless you set the explicit override. The password
fields never show saved credentials. The plugin encrypts these values with keys
derived from WordPress's authentication keys. If you change those keys, enter
the values again.

For managed deployments, set `OPENRECEIVE_NWC_URI` in `wp-config.php` from your
server's secret environment. It overrides the settings field. To configure swap
providers, you can also set the `OPENRECEIVE_LSC_URI_PRIMARY` and
`OPENRECEIVE_LSC_URI_BACKUP` constants. Never put these values in browser code
or logs.

## Checkout and settlement

Both WooCommerce checkout blocks and classic checkout send the customer to the
order-pay page. There, the plugin reads the amount from `WC_Order` and serves
the bundled checkout. It lets the customer in through one of:

- their account
- their checkout session
- an expiring signed cookie, issued after it verifies the order-pay key

Keep that order-pay URL available. Customers use it to return to a pending
payment or a swap refund. The plugin checks that each requested payment hash
belongs to the order.

The plugin saves each payment attempt before it shows invoice instructions. It
records settlement exactly once, inside the payment's database transaction.
WooCommerce's `payment_complete` then handles order status, stock and emails.
The plugin also keeps a durable marker on the order. If something interrupts the
step between settlement and order completion, later requests and scheduled runs
use that marker to finish it.

While the checkout polls for status, it also asks the PHP engine to check the
wallet for payments. The engine's shared database gate keeps these checks from
running too often. Action Scheduler adds a safety net that runs every minute.
On stores with little traffic, set up a system cron to run WordPress scheduled
work. WP-Cron only runs on page visits, so on its own it cannot guarantee
prompt settlement. You can also run these commands under a process manager:

```sh
wp openreceive doctor
wp openreceive reconcile
wp openreceive notifications
```

The notifications command runs as a separate process. The Doctor panel in the
gateway settings reports on the schema, whether credentials are present,
scheduling, and orders that need attention. If the store currency has no usable
price feed, the gateway is unavailable.

## Refunds and removal

The receive-only wallet cannot send merchant refunds. Send those yourself from
your wallet. Payer swap refunds go through the configured provider, on the same
authorized order-pay page. If you turn on LSC payments, you commit to keeping
that recovery path available. See [swap refunds](swap-refunds.md).

Deactivating the plugin keeps payment records. Deleting the plugin drops its two
tables only if **Remove data on uninstall** was enabled. WooCommerce orders are
always kept.

## Local example

The repository's `examples/wordpress` Docker stack builds the plugin. It fills
WooCommerce with products from the shared button catalog. Run
`npm run demo wordpress` to use a real wallet. For a throwaway shop with a fake
wallet, use the stack's documented `compose.testkit.yml` override. No testkit
routes are registered by default.
