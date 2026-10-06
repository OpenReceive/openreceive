# OpenReceive agent directions (WordPress + WooCommerce)

These directions describe OpenReceive 0.4.15.

Install and configure the OpenReceive gateway in the existing WooCommerce
store. Preserve its theme, checkout, customer accounts, order model and prices.
The plugin bundles the PHP engine and checkout assets; the merchant does not
install npm or Composer packages on the WordPress server.

## Step 0 — collect and save the codes, one at a time

Inspect WordPress, WooCommerce and PHP versions and GMP/sodium in both the web
and WP-CLI runtimes. If installed, use `wp openreceive doctor` to see which
credentials are set, without displaying their values. Skip codes already set.
Do not search other projects, container environments or deployment secrets.

Ask for the missing receive-only NWC code first, with this walkthrough:

> In Rizful, open the menu → NWC → Receive-only NWC code → Copy
> (https://openreceive.org/get_a_nwc_code_to_receive_payments). Alby Hub also
> works: Connections → Add Connection → Read Only. Paste the code here and
> I will save it for you.

Install the exact built plugin archive described below if needed. When the code
arrives, save it yourself with `wp openreceive configure --nwc-uri=-`, supplying
the code through the process's stdin. Never put it in shell arguments, shell
history, logs, source files or browser code. Do not ask the user to edit PHP or
an environment file. The command encrypts the code and runs wallet preflight
before saving; a failure preserves existing settings. Constants in wp-config.php
remain authoritative; if a constant must change, use the host's secret workflow.

Next ask whether customers should also pay with USDT, USDC, SOL and ETH, unless
the user already requested these. A configured swap provider converts payments
to BTC over Lightning in the merchant's connected wallet; available assets and
networks depend on the provider. Ask for the LSC code separately:

> Go to https://lightning-swap.com, sign in for API keys, create a key, and copy
> the whole URI (https://openreceive.org/set_up_swap_provider). Paste it here
> and I will save it, or say “Bitcoin only”.

Save it with `wp openreceive configure --lsc-uri-primary=-` through stdin.
Mention FixedFloat only if the merchant already uses it. Save an optional backup
separately with `--lsc-uri-backup=-`. Do not use generic `wp wc payment_gateway`
or REST settings writes for credentials: they are deliberately rejected.

Run `wp openreceive configure --enable`, then `wp openreceive doctor`. Resolve
failed checks before checkout testing. Create an unpaid test order and verify
that the order-pay page opens, lists the configured methods, and resumes its
Lightning invoice on reload. Ask the merchant to pay only if they want a real
settlement test.

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

- [WordPress + WooCommerce Quickstart](https://openreceive.org/guides/quickstart-woocommerce.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)
- [Payment Safety Upgrade](https://openreceive.org/guides/payment-safety-upgrade.md)

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-woocommerce.

## WordPress + WooCommerce quickstart

The [WordPress integration entry point](https://openreceive.org/integrations/wordpress)
redirects to the WooCommerce integration, which uses this same guide and agent
directions. OpenReceive checkout on WordPress requires WooCommerce.

Activate WooCommerce first. Then install the built OpenReceive plugin zip
through **Plugins → Add New → Upload Plugin**. You cannot upload the source
directory as-is. It needs a build first. The plugin is not yet submitted to
WordPress.org.

Requirements: WordPress 6.6+, WooCommerce 9+, 64-bit PHP 8.2+ with GMP and sodium,
and MySQL 8 or MariaDB 10.5+. When you activate the plugin, it creates tables for
payment attempts in your existing WordPress database. You do not need a separate
database or application.

### Get the installable archive

Download [openreceive-wordpress-0.4.15.zip](https://github.com/OpenReceive/openreceive/releases/download/v0.4.15/openreceive-wordpress-0.4.15.zip)
from the matching release. Historical releases may lack this asset. If that exact
URL returns 404, build the same tag below; never silently install an older ZIP.
The GitHub source-code ZIP is not an installable plugin. On a development machine
with Node 22+, PHP 8.2+ with GMP/sodium, Composer and WP-CLI:

```sh
git clone https://github.com/OpenReceive/openreceive.git
cd openreceive
git checkout v0.4.15
npm ci
npm run build:packages
composer install --working-dir=packages/php/wordpress
npm run release:wordpress:build
```

Upload the resulting `dist/openreceive-wordpress-<version>.zip`. The build
needs WP-CLI on `PATH`. Otherwise, set `OPENRECEIVE_WP_CLI` to the absolute path
of its phar. Your WordPress server needs neither Node nor Composer. The built
plugin already bundles its dependencies and checkout assets.

### Enable GMP in both PHP runtimes

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
runtimes; if they cannot, this plugin cannot run there. Do not use Composer's
`--ignore-platform-reqs` to bypass the requirements.

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

#### Configure through WP-CLI

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
The default payment title becomes “Bitcoin & crypto (OpenReceive)” with swaps;
a customized title is preserved.

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
