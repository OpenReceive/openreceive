# OpenReceive agent directions (WordPress + WooCommerce)

These directions describe OpenReceive 0.4.11.

Install and configure the OpenReceive gateway in the existing WooCommerce
store. Preserve its theme, checkout, customer accounts, order model and prices.
The plugin bundles the PHP engine and checkout assets; the merchant does not
install npm or Composer packages on the WordPress server.

## Step 0 — inspect configuration

Check WordPress, WooCommerce and PHP versions, GMP and sodium availability,
whether the plugin is installed, and whether the Doctor panel reports the
receive-only NWC credential as set. Never display its value. For a real store,
ask the merchant to configure a receive-only wallet if none is available.
For repository development, use the Docker demo's explicit testkit override.

Upload a built plugin archive, not a zip of the source directory. The plugin
has not yet been accepted into the WordPress.org directory. Configuration and
the complete quickstart follow below.

The plugin owns only its payment-attempt tables in the WordPress database.
WooCommerce owns orders, totals, stock and email. Do not add an external
idempotency store, payment database, browser wallet credentials or custom
fulfillment implementation. Guest return links use WooCommerce's order key;
the plugin verifies it before issuing an expiring order-bound cookie.

Run `wp openreceive doctor` after configuration. Use the documented scheduled
reconciliation or optional notifications command for offline settlement.
Manual merchant refunds and provider-managed payer swap refunds are separate
flows; a receive-only NWC wallet cannot send payments.

## Further reading

- [Express Quickstart (Node)](https://openreceive.org/guides/quickstart-node.md)
- [Fastify Quickstart](https://openreceive.org/guides/quickstart-fastify.md)
- [FastAPI Quickstart](https://openreceive.org/guides/quickstart-fastapi.md)
- [Django Quickstart](https://openreceive.org/guides/quickstart-django.md)
- [Next.js Quickstart](https://openreceive.org/guides/quickstart-next.md)
- [Rails Quickstart](https://openreceive.org/guides/quickstart-rails.md)
- [PHP Quickstart (plain PHP)](https://openreceive.org/guides/quickstart-php.md)
- [Laravel Quickstart](https://openreceive.org/guides/quickstart-laravel.md)
- [BTCPay Server Quickstart](https://openreceive.org/guides/quickstart-btcpay.md)
- [BTCPay Plugin Reference](https://openreceive.org/guides/btcpay-reference.md)
- [Node ORM Recipes](https://openreceive.org/guides/node-orms.md)
- [Authorization](https://openreceive.org/guides/authorization.md)
- [Rate Limiting](https://openreceive.org/guides/rate-limiting.md)
- [Frontend Checkout](https://openreceive.org/guides/frontend-checkout.md)
- [Checkout UX](https://openreceive.org/guides/checkout-ux.md)
- [Headless Checkout](https://openreceive.org/guides/headless-checkout.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Environment Variables](https://openreceive.org/guides/environment-variables.md)
- [Payment Storage](https://openreceive.org/guides/storage.md)
- [Deploying OpenReceive](https://openreceive.org/guides/deploying.md)
- [Testing Your OpenReceive Integration](https://openreceive.org/guides/host-testing.md)
- [API Reference](https://openreceive.org/guides/api-reference.md)
- [Security](https://openreceive.org/guides/security.md)
- [Provider Registry](https://openreceive.org/guides/provider-registry.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)
- [React Material UI Recipe](https://openreceive.org/guides/react-material-ui-recipe.md)
- [Flask Recipe](https://openreceive.org/guides/flask-recipe.md)
- [Writing Your Own Checkout Route](https://openreceive.org/guides/custom-checkout-route.md)
- [Agent Directions: Node.js](https://openreceive.org/guides/agent-directions-node.md)
- [Agent Directions: Fastify](https://openreceive.org/guides/agent-directions-fastify.md)
- [Agent Directions: FastAPI](https://openreceive.org/guides/agent-directions-fastapi.md)
- [Agent Directions: Django](https://openreceive.org/guides/agent-directions-django.md)
- [Agent Directions: Next.js](https://openreceive.org/guides/agent-directions-next.md)
- [Agent Directions: Rails](https://openreceive.org/guides/agent-directions-rails.md)
- [Agent Directions: PHP](https://openreceive.org/guides/agent-directions-php.md)
- [Agent Directions: Laravel](https://openreceive.org/guides/agent-directions-laravel.md)
- [Agent Directions: BTCPay Server](https://openreceive.org/guides/agent-directions-btcpay.md)
- [WordPress + WooCommerce Quickstart](https://openreceive.org/guides/quickstart-woocommerce.md)

- https://openreceive.org/guides/payment-safety-upgrade.md — coordinated upgrades and reviewed repair of existing attempts

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-woocommerce.

## WordPress + WooCommerce quickstart

Activate WooCommerce first. Then install the built OpenReceive plugin zip
through **Plugins → Add New → Upload Plugin**. You cannot upload the source
directory as-is. It needs a build first. The plugin is not yet submitted to
WordPress.org.

Requirements: WordPress 6.6+, WooCommerce 9+, 64-bit PHP 8.2+ with GMP and sodium,
and MySQL 8 or MariaDB 10.5+. When you activate the plugin, it creates tables for
payment attempts in your existing WordPress database. You do not need a separate
database or application.

### Get the installable archive

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

### Configure the wallet

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

### Checkout and settlement

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

### Refunds and removal

The receive-only wallet cannot send merchant refunds. Send those yourself from
your wallet. Payer swap refunds go through the configured provider, on the same
authorized order-pay page. If you turn on LSC payments, you commit to keeping
that recovery path available. See [swap refunds](https://openreceive.org/guides/swap-refunds.md).

Deactivating the plugin keeps payment records. Deleting the plugin drops its two
tables only if **Remove data on uninstall** was enabled. WooCommerce orders are
always kept.

### Local example

The repository's `examples/wordpress` Docker stack builds the plugin. It fills
WooCommerce with products from the shared button catalog. Run
`npm run demo wordpress` to use a real wallet. For a throwaway shop with a fake
wallet, use the stack's documented `compose.testkit.yml` override. No testkit
routes are registered by default.
