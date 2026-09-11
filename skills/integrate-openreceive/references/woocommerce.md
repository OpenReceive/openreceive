# OpenReceive agent directions (WordPress + WooCommerce)

These directions describe OpenReceive 0.4.6.

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

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-woocommerce.

## WordPress + WooCommerce quickstart

Install the built OpenReceive plugin zip through **Plugins → Add New → Upload
Plugin**, with WooCommerce already active. The source directory needs a build;
it cannot be uploaded as-is. WordPress.org submission is still pending.

Requirements: WordPress 6.6+, WooCommerce 9+, 64-bit PHP 8.2+ with GMP and sodium,
and MySQL 8 or MariaDB 10.5+. Activation creates payment-attempt tables in the
existing WordPress database. No separate database or application is required.

### Get the installable archive

Use `openreceive-wordpress-<version>.zip` from the selected
[OpenReceive GitHub release](https://github.com/OpenReceive/openreceive/releases)
when that asset is listed. A GitHub source-code zip is not the plugin archive.
If the release does not yet provide a built zip, build it on a development
machine with Node 22+, PHP 8.2+, Composer and WP-CLI:

```sh
git clone https://github.com/OpenReceive/openreceive.git
cd openreceive
git checkout <release-tag>
npm ci
npm run build:packages
composer install --working-dir=packages/php/wordpress
npm run release:wordpress:build
```

Upload the resulting `dist/openreceive-wordpress-<version>.zip`. WP-CLI must be
on `PATH`, or set `OPENRECEIVE_WP_CLI` to the absolute path of its phar. The
WordPress server needs neither Node nor Composer: dependencies and checkout
assets are bundled inside the built plugin.

### Configure the wallet

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

### Checkout and settlement

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

### Refunds and removal

The receive-only wallet cannot send merchant refunds. Make those manually from
your wallet. Payer swap refunds use the configured provider through the same
authorized order-pay page; enabling LSC payments commits the shop to keeping
that recovery path available. See [swap refunds](https://openreceive.org/guides/swap-refunds.md).

Deactivation preserves payment records. Deleting the plugin drops its two
tables only if **Remove data on uninstall** was enabled. WooCommerce orders are
retained.

### Local example

The repository's `examples/wordpress` Docker stack builds the plugin and seeds
WooCommerce from the shared button catalog. Run `npm run demo wordpress` for
the real-wallet mode, or use its documented `compose.testkit.yml` override for
a disposable fake-wallet shop. No testkit routes are registered by default.
