# Easy Digital Downloads quickstart

[Easy Digital Downloads](https://easydigitaldownloads.com) (EDD) sells digital
products from WordPress. The OpenReceive plugin, the same one WooCommerce
stores use, adds a payment gateway to it: the customer pays with Bitcoin over
Lightning, straight into your own wallet. With a swap provider, the same
checkout also takes USDT, USDC, SOL and ETH, which the provider converts to
BTC over Lightning into the same wallet.

EDD keeps owning products, prices, customers, orders and download access. The
customer picks the OpenReceive method at EDD's checkout. EDD records a pending
order, and its purchase confirmation page shows the checkout until the order
is paid. Once the wallet reports the payment, EDD completes the order, sends
its receipt and opens the downloads, as it does for any other gateway.

Requirements: WordPress 6.6+, Easy Digital Downloads 3+, 64-bit PHP 8.2+ with
GMP and sodium, and MySQL 8 or MariaDB 10.5+. When you activate the plugin, it
creates tables for payment attempts in your existing WordPress database. The
plugin works with EDD alone, with WooCommerce alone, or with both on one site.

## Install the plugin

In **Plugins → Add New**, search for **OpenReceive**, then install and
activate it. With WP-CLI, run `wp plugin install openreceive --activate`.

Each GitHub release also attaches the plugin as a ZIP, for a site that cannot
reach WordPress.org:
[openreceive-wordpress-0.4.28.zip](https://github.com/OpenReceive/openreceive/releases/download/v0.4.28/openreceive-wordpress-0.4.28.zip).
Install it through **Plugins → Add New → Upload Plugin**. The GitHub
source-code ZIP is not an installable plugin.

## Enable GMP in both PHP runtimes

GMP is required by the bundled elliptic-curve code, in the web PHP and in the
PHP that runs WP-CLI. If the plugin is not running, the Plugins screen says
which requirement is missing. On managed hosting, ask the host to enable GMP
and sodium; [WordPress hosting requirements](wordpress-hosting.md) lists what
common hosts offer. On Debian or Ubuntu, install the package for your PHP
version, such as `php8.2-gmp`, and restart that PHP.

Many Docker sites run the official images straight from Compose, for example
`image: wordpress:php8.2-apache` and `image: wordpress:cli-php8.2`, and both
lack GMP. Add two Dockerfiles next to `compose.yml`, keeping your tags:

```dockerfile
# wordpress.Dockerfile
FROM wordpress:php8.2-apache
RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev \
    && docker-php-ext-install gmp \
    && rm -rf /var/lib/apt/lists/*
```

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

Replace each service's `image:` line with a `build:` key, such as
`build: { context: ., dockerfile: wordpress.Dockerfile }`, then run
`docker compose build wordpress cli` and `docker compose up -d wordpress`. Use
your own service names, and add no other service.

## Configure the wallet

You need a receive-only NWC code: a Nostr Wallet Connect code that can create
invoices and read payments but cannot spend. The plugin refuses a code that
can spend.

1. Open **Downloads → Settings → Payments → OpenReceive**.
2. Paste the code into **NWC code** and save. To accept stablecoins too, paste
   a swap provider code into **Lightning Swap Connect code**.
3. Open **Payments → General**, tick **OpenReceive (Bitcoin Lightning)** under
   **Active Gateways**, and save.

When you save, the plugin checks that the wallet can receive, then stores the
codes encrypted with keys derived from WordPress's authentication keys. The
fields never show a saved code; they say only whether one is set. EDD's own
settings never hold a code. The settings page ends with the OpenReceive
Doctor, the same checks as `wp openreceive doctor`.

With WP-CLI, pipe each code in from your secret manager or a protected file,
never a code typed into the command:

```sh
wp openreceive configure --nwc-uri=- < /secure/path/wallet-code
wp openreceive configure --lsc-uri-primary=- < /secure/path/swap-code
wp openreceive configure --enable
wp openreceive doctor
```

`--enable` adds OpenReceive to EDD's active gateways (and turns it on in
WooCommerce, when that runs too). Omit the swap command for Bitcoin-only
checkout. `doctor` checks the store, GMP and sodium, each code as set or
unset (never its value), the tables, the wallet, the price feed for the store
currency, each swap provider and the scheduled pass, and exits nonzero when a
check fails. Codes set as `OPENRECEIVE_NWC_URI` or
`OPENRECEIVE_LSC_URI_PRIMARY` constants in `wp-config.php` win over saved ones.

## Check it

Make a Lightning invoice through the same route the purchase confirmation page
uses, for a new pending test order:

```sh
wp openreceive test-invoice --new
wp openreceive test-invoice edd-<order id>
```

`--new` orders your first published download, billed to the first
administrator; a pending order sends no email. To use an order that already
exists, pass its id with the `edd-` prefix. It prints the amount in sats, the
Lightning invoice and the receipt page, then each method the checkout offers:
Bitcoin Lightning, and each swap asset with its network and whether it is
available for this amount. A small order is often below a swap provider's
minimum; that is the amount, not a fault. The receipt page shows the checkout
to the order's customer, or to you while you are signed in to WordPress as
the shop manager. Delete the test order under **Downloads → Orders** when you
are done.

## How a payment works

1. The customer picks the OpenReceive method at checkout and presses
   **Purchase**. EDD records a pending order and opens its purchase
   confirmation page, which shows the checkout.
2. The plugin charges the order's total in the store currency, converted to
   sats at the current BTC price. Only the customer, signed in, or the browser
   EDD showed the receipt to (a guest included), can make or follow the
   order's payment.
3. Once the wallet reports the payment, the plugin records it in the same
   database transaction that settles it. Right after, EDD completes the order
   with the payment hash as its transaction id, sends the receipt and opens
   the downloads. If that step is interrupted, the next request or scheduled
   pass finishes it.
4. The page reloads to the completed receipt.

The checkout asks the wallet while the page is open. If the customer closes
it before the payment settles, a pass every minute on Action Scheduler (which
EDD bundles) finds the payment. WordPress runs scheduled work on page visits,
so on a quiet store a system cron for WordPress settles such orders sooner.
`wp openreceive reconcile` runs one pass by hand.

## Refunds and removal

The receive-only wallet cannot send refunds. Send a refund from your own
wallet, then record it in EDD. A customer whose swap deposit never converted
reclaims it from the same order's purchase confirmation page. If you turn on
swaps, you commit to keeping that page available. See
[swap refunds](swap-refunds.md).

Deactivating or deleting the plugin keeps its two payment tables: they are a
record of payments received. (On a site that also runs WooCommerce, its
**Remove data on uninstall** setting drops them on deletion.) EDD orders are
always kept.

## Tested, and not tested

Tested on 2026-10-16 with WordPress 7.1 and Easy Digital Downloads 3.7.2,
alone and next to WooCommerce 11.1, on MySQL 8, with a test wallet and a test
swap provider: install from the built ZIP, configure from stdin and from EDD's
settings page, the doctor, `test-invoice --new`, and a signed-in customer and
a guest paying by Lightning and by USDT on Solana in Chromium, after which the
order reads Completed. Another customer and a visitor were refused. The
repository's WordPress CI buys a download as a guest on every push.

Not tested: EDD's subscriptions (Recurring Payments), multisite, and stores
whose purchase confirmation page lacks EDD's receipt block or shortcode.
Lightning cannot pull a payment, so OpenReceive takes no subscription
renewals.

## Next

- [Swap refunds](swap-refunds.md)
- [How OpenReceive stores payments](storage.md)
- [Payment safety](payment-safety-upgrade.md)
