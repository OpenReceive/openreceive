# WordPress + WooCommerce quickstart

The [WordPress integration entry point](https://openreceive.org/integrations/wordpress)
redirects to the WooCommerce integration, which uses this same guide and agent
directions. OpenReceive checkout on WordPress requires WooCommerce.

Activate WooCommerce first. Then install OpenReceive from the
[WordPress.org plugin directory](https://wordpress.org/plugins/openreceive/):
in **Plugins → Add New**, search for **OpenReceive**, then install and
activate it. With WP-CLI, run `wp plugin install openreceive --activate`.
WordPress offers each new release as an ordinary plugin update.

Requirements: WordPress 6.6+, WooCommerce 9+, 64-bit PHP 8.2+ with GMP and sodium,
and MySQL 8 or MariaDB 10.5+. When you activate the plugin, it creates tables for
payment attempts in your existing WordPress database. You do not need a separate
database or application.

## Get the installable archive

Each GitHub release also attaches the same plugin as a ZIP, for a site that
cannot reach WordPress.org or when WordPress.org does not list a release yet.
Download [openreceive-wordpress-0.4.22.zip](https://github.com/OpenReceive/openreceive/releases/download/v0.4.22/openreceive-wordpress-0.4.22.zip)
and install it through **Plugins → Add New → Upload Plugin**. Historical
releases may lack this asset. If that exact URL returns 404, build the same tag
below; never silently install an older ZIP. The GitHub source-code ZIP is not
an installable plugin. On a development machine with Node 22+, PHP 8.2+ with
GMP/sodium, Composer and WP-CLI:

```sh
git clone https://github.com/OpenReceive/openreceive.git
cd openreceive
git checkout v0.4.22
npm ci
npm run build:packages
composer install --working-dir=packages/php/wordpress
npm run release:wordpress:build
```

Upload the resulting `dist/openreceive-wordpress-<version>.zip`. The build
needs WP-CLI on `PATH`. Otherwise, set `OPENRECEIVE_WP_CLI` to the absolute path
of its phar. Your WordPress server needs neither Node nor Composer. The built
plugin already bundles its dependencies and checkout assets.

## Enable GMP in both PHP runtimes

GMP is required by the bundled elliptic-curve dependency. Enable it for both
web PHP (Apache/FPM) and the PHP executable running WP-CLI. Installing it in
only the WordPress container does not update a separate CLI container.

For Debian-based official PHP/WordPress images, add to **each** Dockerfile:

```dockerfile
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev \
    && docker-php-ext-install gmp \
    && rm -rf /var/lib/apt/lists/*
```

For Alpine-based PHP/CLI images:

```dockerfile
USER root
RUN apk add --no-cache gmp \
    && apk add --no-cache --virtual .gmp-build $PHPIZE_DEPS gmp-dev \
    && docker-php-ext-install gmp \
    && apk del .gmp-build
```

Restore the base image's original runtime user after installing extensions.
Rebuild and recreate both containers. On Debian/Ubuntu hosts, install the GMP
package matching the active PHP version (for example `php8.2-gmp` for PHP 8.2),
then restart that version's web PHP service. Verify `php --ri gmp` and
`wp openreceive doctor` for CLI, and the gateway Doctor panel for web PHP.
On managed WordPress hosting, ask the host to enable GMP and sodium in both
runtimes; if they cannot, this plugin cannot run there.
[WordPress hosting requirements](wordpress-hosting.md) lists what common hosts
offer and how to check your site. Do not use Composer's
`--ignore-platform-reqs` to bypass the requirements.

### Compose files with only `image:` lines

Many stores run the official images straight from Compose, for example
`image: wordpress:php8.2-apache` and `image: wordpress:cli-php8.2`, with no
Dockerfile. Add two Dockerfiles next to `compose.yml`, keeping the tags your
`image:` lines had. The web image is Debian and runs as root:

```dockerfile
# wordpress.Dockerfile
FROM wordpress:php8.2-apache
RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev \
    && docker-php-ext-install gmp \
    && rm -rf /var/lib/apt/lists/*
```

The CLI image is Alpine and runs as `www-data`:

```dockerfile
# wp-cli.Dockerfile
FROM wordpress:cli-php8.2
USER root
RUN apk add --no-cache gmp \
    && apk add --no-cache --virtual .gmp-build $PHPIZE_DEPS gmp-dev \
    && docker-php-ext-install gmp \
    && apk del .gmp-build
USER www-data
```

In `compose.yml`, replace each of those two `image:` lines with a `build:` key
and leave the rest of both services as they are:

```yaml
services:
  wordpress:
    build: { context: ., dockerfile: wordpress.Dockerfile }
  cli:
    build: { context: ., dockerfile: wp-cli.Dockerfile }
```

Then run `docker compose build wordpress cli` and `docker compose up -d wordpress`.
Use your own service names. Do not add any other service for this.

## Configure the wallet

On managed hosting with no shell or WP-CLI, use these admin screens. With WP-CLI,
use [Configure through WP-CLI](#configure-through-wp-cli) below instead.

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

### Configure through WP-CLI

`wp openreceive configure` accepts one credential at a time from stdin. Feed
stdin through your secret manager or an existing protected file, never a code
literal in the command line:

```sh
wp openreceive configure --nwc-uri=- < /secure/path/wallet-code
wp openreceive configure --lsc-uri-primary=- < /secure/path/swap-code
wp openreceive configure --enable
wp openreceive doctor
```

Omit the swap command for Bitcoin-only checkout. `--lsc-uri-backup=-` adds a
backup. These commands share admin preflight and encrypted storage. Credential
flags accept only `-`; blank input leaves settings intact. Generic WooCommerce
REST and `wp wc payment_gateway` credential updates are rejected. `doctor`
reports the failed check with credentials redacted and exits nonzero on failure.
It also asks each configured swap provider for its asset list, and fails when a
provider does not answer or offers no assets. The default payment title becomes “Bitcoin & stablecoins (OpenReceive)” with swaps;
a customized title is preserved.

To check checkout from the terminal, mint an invoice for an unpaid order whose
payment method is OpenReceive:

```sh
wp wc shop_order create --user=<admin user id> --payment_method=openreceive \
  --line_items='[{"product_id":<product id>,"quantity":1}]' --porcelain
wp openreceive test-invoice <order id>
```

`test-invoice` uses the same checkout route as the order-pay page. It prints the
amount in sats, the Lightning invoice and the order-pay link, which opens the
checkout on that invoice. It then lists the methods that page offers: Bitcoin
Lightning, plus each swap asset with its network and whether it is available
for this amount, with the reason when it is not. A small test order is often
below a provider's minimum; that is the order's amount, not a fault. Delete the
test order when you are done.

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
WP-Cron only runs on page visits, so on a store with little traffic that safety
net waits for the next visitor. A system cron that runs WordPress scheduled
work settles those orders sooner. It is a recommendation for the store owner,
not a setup step.

`wp openreceive reconcile` runs one settlement pass and exits.
`wp openreceive notifications` is an optional long-running worker that settles
a payment as soon as the wallet reports it; run it under a process manager only
if you want that. Setup needs neither.

The Doctor panel in the gateway settings reports on the schema, whether
credentials are present, whether each swap provider answers, scheduling, and
orders that need attention. If the store currency has no usable price feed, the
gateway is unavailable.

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
