# WordPress + WooCommerce quickstart

Install the built OpenReceive plugin zip through **Plugins → Add New → Upload
Plugin**, with WooCommerce already active. The source directory needs a build;
it cannot be uploaded as-is. WordPress.org submission is still pending.

Requirements: WordPress 6.6+, WooCommerce 9+, 64-bit PHP 8.2+ with GMP and sodium,
and MySQL 8 or MariaDB 10.5+. Activation creates payment-attempt tables in the
existing WordPress database. No separate database or application is required.

## Configure the wallet

Open **WooCommerce → Settings → Payments → OpenReceive**. Enter a receive-only
NWC code, save, then enable the gateway. Saving verifies receive permissions
and fails closed on a spend-capable wallet unless the explicit override is set.
The password fields never show saved credentials. Values are encrypted using
keys derived from WordPress's authentication keys; re-enter them after rotating
those keys.

For managed deployments, configure `OPENRECEIVE_NWC_URI` in `wp-config.php` from
your server's secret environment. It takes precedence over the settings field.
Optional `OPENRECEIVE_LSC_URI_PRIMARY` and `OPENRECEIVE_LSC_URI_BACKUP` constants
configure swap providers. Never put these values in browser code or logs.

## Checkout and settlement

Both WooCommerce checkout blocks and classic checkout redirect to the order-pay
page. The plugin reads the amount from `WC_Order`, serves the bundled checkout,
and authorizes the customer through their account, checkout session or an
expiring signed cookie issued after verifying the order-pay key. Keep that
order-pay URL available to customers returning to a pending payment or swap
refund. The plugin verifies that each requested payment hash belongs to the order.

Payment attempts persist before invoice instructions appear. Settlement commits
once in the payment transaction. WooCommerce's `payment_complete` then handles
status, stock and emails. A durable order marker lets subsequent requests and
scheduled passes repair an interruption between settlement and order completion.

The checkout polling drives opportunistic reconciliation through the PHP
engine's shared database gate. Action Scheduler adds a recurring one-minute
safety net. Configure a system cron to run WordPress scheduled work on stores
with little traffic; no page visits means WP-Cron alone cannot guarantee prompt
settlement. Optional process-manager commands:

```sh
wp openreceive doctor
wp openreceive reconcile
wp openreceive notifications
```

The notifications command runs as a separate process. The Doctor panel in the
gateway settings reports schema, credential presence, scheduling and attention
orders. A currency without a usable price feed makes the gateway unavailable.

## Refunds and removal

The receive-only wallet cannot send merchant refunds. Make those manually from
your wallet. Payer swap refunds use the configured provider through the same
authorized order-pay page; enabling LSC payments commits the shop to keeping
that recovery path available. See [swap refunds](swap-refunds.md).

Deactivation preserves payment records. Deleting the plugin drops its two
tables only if **Remove data on uninstall** was enabled. WooCommerce orders are
retained.

## Local example

The repository's `examples/wordpress` Docker stack builds the plugin and seeds
WooCommerce from the shared button catalog. Run `npm run demo wordpress` for
the real-wallet mode, or use its documented `compose.testkit.yml` override for
a disposable fake-wallet shop. No testkit routes are registered by default.
