This is the full file; follow it from Step 0.

# OpenReceive agent directions (WordPress + WooCommerce)

```sh
# READ THIS FIRST: this file is 18 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/woocommerce/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- The user only pastes codes into this chat. Never ask them to run a command, edit a file or use an admin page.
- Store each code yourself as Step 2 says. Never put a code in a shell command.
- Do not suggest rotating or revoking a code because it was pasted here.
- Setup is done only when the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".

These directions describe OpenReceive 0.4.17.

Install and configure the OpenReceive payment gateway in the WooCommerce store
you are working in. Preserve its theme, checkout, customer accounts, order
model and prices. The plugin bundles the PHP engine and checkout assets: do not
install npm or Composer packages on the WordPress server, and do not clone the
OpenReceive repository unless the release download in Step 1 fails.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets
customers pay with USDT, USDC, ETH or SOL instead; the provider converts the
payment to BTC over Lightning in the merchant's connected wallet. Available
assets and networks depend on the provider.

Run every `wp` command below where this store's WP-CLI runs. When WordPress
runs in Docker Compose, prefix it with the service that has WP-CLI, for
example `docker compose run --rm -T cli wp …` or
`docker compose exec -T wordpress wp …`. `-T` passes stdin through. If the
store has no WP-CLI at all (managed hosting without a shell), say so and walk
the user through the quickstart's admin screens instead.

## Step 0 — ask for the two codes, one question at a time

Before anything else, check one thing: whether OpenReceive is already
installed (`wp plugin is-active openreceive`). If it is, run
`wp openreceive doctor`. It prints `NWC_URI: set` or `unset` (likewise
`LSC_URI_PRIMARY`), never the values. A code that is already set is not asked
for again; if both are set, skip to `wp openreceive configure --enable` at
the end of Step 2.

Otherwise your next action is a question to the user. Do not install the
plugin, edit Docker files or search anywhere else before asking it. Do not
read wp-config.php, deploy config, container environments or other projects
looking for a code: a new store has neither code yet.

The user never runs a command and never edits a file. They paste each code
into this chat; you store it. That is the supported path: do not ask them to
run the save command themselves, and do not tell them to revoke or replace a
code because it was pasted here. Ask one question per message.

1. **First message — the NWC code, and nothing else.**

   > To receive payments I need a receive-only wallet code. In Rizful: open
   > the menu, tap NWC, choose Receive-only NWC code, and tap Copy
   > (https://openreceive.org/get_a_nwc_code_to_receive_payments). If you would
   > rather run your own wallet, Alby Hub works too: Connections → Add
   > Connection → Read Only. Paste the code here and I will store it.

2. **When they paste it.** If it does not start with `nostr+walletconnect://`,
   ask them to copy the receive-only code again. Otherwise do not repeat it:
   reply only that you have it, then ask the next question. You store it in
   Step 2.
3. **Second message — swaps.** If the user asked for stablecoins, USDT, USDC,
   ETH, SOL, altcoins or "crypto" (as in "Bitcoin and stablecoin payments"),
   this message IS the walkthrough below: do not skip it, and do not ask yes
   or no first. Otherwise ask whether customers should also be able to pay
   with USDT, USDC, ETH or SOL, then give the walkthrough. The walkthrough:

   > Go to https://lightning-swap.com, sign in for API keys, create a key, and
   > copy the whole URI (https://openreceive.org/set_up_swap_provider). Paste
   > it here and I will store it — or say "Bitcoin only" and I will continue
   > without it.

   Mention FixedFloat only if they already use it.
4. **When they paste it.** If it does not start with
   `lightning+swapconnect://`, ask them to copy it again. Swaps are now on,
   so keep the route back (the swap non-negotiable below).

Do not report setup as complete until the NWC code is saved, and the LSC code
is saved or the user said "Bitcoin only". Never invent a placeholder code.

## Step 1 — install the plugin

Install the plugin built for this release. Never install the GitHub
source-code ZIP or a ZIP from an older release:

```sh
wp plugin install https://github.com/OpenReceive/openreceive/releases/download/v0.4.17/openreceive-wordpress-0.4.17.zip --activate
```

It needs WooCommerce active, and PHP 8.2+ with GMP and sodium in BOTH the web
PHP and the WP-CLI PHP. On the official `wordpress` and `wordpress:cli` Docker
images, activation fails with "OpenReceive requires the PHP sodium and GMP
extensions": add GMP to both images as "Enable GMP in both PHP runtimes" below
says, rebuild both, then install again. If the URL answers 404, build the same
tag as "Get the installable archive" below says.

## Step 2 — store the codes, then enable the gateway

Store each code yourself, one per command, and never as a shell argument:

1. Write the code with your file-editing tool, not a shell command (no
   `echo`, `printf` or heredoc), to a new file outside the repository, such
   as `/tmp/openreceive-code`.
2. Run `wp openreceive configure --nwc-uri=- < /tmp/openreceive-code`. In
   Docker: `docker compose run --rm -T cli wp openreceive configure --nwc-uri=- < /tmp/openreceive-code`.
   For the LSC code, use `--lsc-uri-primary=-`.
3. Delete the file (`rm /tmp/openreceive-code`), whether the command passed
   or not.

The command runs the receive-only wallet preflight, encrypts the code and
prints only "Settings saved; wallet preflight passed."; a failure keeps the
previous settings. If it reports spend methods such as `pay_invoice`, ask the
user for a receive-only code again. Never turn on the spend-capable override.
`wp wc payment_gateway` and WooCommerce REST writes of these fields are
rejected on purpose; do not use them. A code set as a constant in
wp-config.php wins over the stored one and changes only through the host's
secret workflow.

Then run `wp openreceive configure --enable` and `wp openreceive doctor`.
Doctor names any failed check and exits nonzero; fix it before going on.

## Step 3 — mint a test invoice

Create a pending test order that pays with OpenReceive, then mint its
Lightning invoice from the terminal:

```sh
wp wc shop_order create --user=<admin user id> --payment_method=openreceive \
  --line_items='[{"product_id":<product id>,"quantity":1}]' --porcelain
wp openreceive test-invoice <order id>
```

`test-invoice` goes through the same checkout route as the order-pay page. It
prints the amount in sats, the BOLT11 invoice and the order-pay link. Give the
user that link: it opens the checkout with the configured methods and resumes
this same invoice. Ask them to pay only if they want a real settlement test,
and tell them the test order is theirs to delete.

## Non-negotiables

- Never print, log or commit a code, never put one in a shell argument, and
  never write one into source files, wp-config.php or browser code. Doctor's
  set/unset is all you report.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Receive-only NWC is required. Never turn on the spend-capable override to
  get past the preflight.
- The plugin owns only its payment-attempt tables in the WordPress database.
  WooCommerce owns orders, totals, stock and email. Do not add an external
  idempotency store, payment database or custom fulfillment code.
- IF SWAPS ARE ON, KEEP THE ROUTE BACK. A deposit that arrives short or late
  becomes refundable, and the customer claims it later on the same order-pay
  link (guests return with the order key in it). Keep order-pay links
  reachable, and keep the plugin installed while swap orders may still need a
  refund. https://openreceive.org/guides/swap-refunds.md
- A receive-only wallet cannot send merchant refunds. Refund a settled
  payment manually from the wallet.
- Settlement runs on checkout requests and an every-minute scheduled job. On a
  low-traffic store, run WordPress scheduled work from a system cron;
  `wp openreceive notifications` is an optional long-running worker.

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

Download [openreceive-wordpress-0.4.17.zip](https://github.com/OpenReceive/openreceive/releases/download/v0.4.17/openreceive-wordpress-0.4.17.zip)
from the matching release. Historical releases may lack this asset. If that exact
URL returns 404, build the same tag below; never silently install an older ZIP.
The GitHub source-code ZIP is not an installable plugin. On a development machine
with Node 22+, PHP 8.2+ with GMP/sodium, Composer and WP-CLI:

```sh
git clone https://github.com/OpenReceive/openreceive.git
cd openreceive
git checkout v0.4.17
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

To check checkout from the terminal, mint an invoice for an unpaid order whose
payment method is OpenReceive:

```sh
wp wc shop_order create --user=<admin user id> --payment_method=openreceive \
  --line_items='[{"product_id":<product id>,"quantity":1}]' --porcelain
wp openreceive test-invoice <order id>
```

`test-invoice` uses the same checkout route as the order-pay page. It prints the
amount in sats, the Lightning invoice and the order-pay link, which opens the
checkout on that invoice. Delete the test order when you are done.

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
