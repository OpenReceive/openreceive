This is the full file; follow it from Step 0.

# OpenReceive agent directions (WordPress + Easy Digital Downloads)

```sh
# READ THIS FIRST: this file is 21 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/edd/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- The user only pastes codes into this chat. Never ask them to run a command, edit a file or use an admin page.
- Store each code yourself as Step 2 says. Never put a code in a shell command.
- Do not suggest rotating or revoking a code because it was pasted here.
- Setup is done only when the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".

These directions describe OpenReceive 0.4.30.

Install and configure the OpenReceive payment gateway in the Easy Digital
Downloads (EDD) store you are working in. Preserve its theme, checkout,
customer accounts, products and prices. The plugin bundles the PHP engine and
checkout assets: do not install npm or Composer packages on the WordPress
server, and do not clone the OpenReceive repository.

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
plugin, edit Docker files or search anywhere else before asking it. PHP
extensions, Docker images and the database wait until both codes are in this
chat, or the user said "Bitcoin only"; Step 1 covers them. Do not read
wp-config.php, deploy config, container environments or other projects
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

Install this release from the WordPress.org plugin directory:

```sh
wp plugin install openreceive --version=0.4.30 --activate
```

If that fails because WordPress.org does not have this version yet, install
the ZIP attached to the same GitHub release. Never install the GitHub
source-code ZIP or a ZIP from an older release:

```sh
wp plugin install https://github.com/OpenReceive/openreceive/releases/download/v0.4.30/openreceive-wordpress-0.4.30.zip --activate
```

It needs Easy Digital Downloads active, and PHP 8.2+ with GMP and sodium in
BOTH the web PHP and the WP-CLI PHP. On the official `wordpress` and
`wordpress:cli` Docker images, activation warns "OpenReceive is not running:
this site needs the PHP GMP extension" and the plugin stays idle: add GMP to
both images with the two Dockerfiles and `build:` keys in the quickstart's
"Enable GMP in both PHP runtimes", rebuild both, then install again. Add no
other service.

## Step 2 — store the codes, then turn the gateway on

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
Never write a code into EDD's settings, `wp option` or wp-config.php yourself.

Then run `wp openreceive configure --enable`, which adds OpenReceive to EDD's
active gateways, and `wp openreceive doctor`. Doctor names any failed check and
exits nonzero; fix it before going on. Its first line says which store it
found: "Store: Easy Digital Downloads active".

## Step 3 — mint a test invoice, then stop

Create a pending test order for the first published download, billed to the
first administrator, and mint its Lightning invoice from the terminal:

```sh
wp openreceive test-invoice --new
```

To use an order that already exists, pass `edd-<order id>` instead of
`--new`. `test-invoice` goes through the same checkout route as the purchase
confirmation page. It prints the amount in sats, the BOLT11 invoice, the
receipt page and the methods that page offers, each swap asset marked
available or followed by the reason it is not. That reason is the answer;
report it. "Below the provider minimum" or "above the provider maximum" is
about this order's amount, not a fault: a small test order is often under a
swap minimum. Only when the reason says the provider is unreachable does
doctor's "Swap provider" line have more detail. `test-invoice` and `doctor`
are the whole checkout check. If it says the store has no published download,
say so: the user adds products, you do not.

Give the user the receipt page, to open in a browser where they are signed in
to WordPress as the shop manager; it shows the checkout on this same invoice.
Tell them the test order is theirs to delete under Downloads → Orders.

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark the order complete, and do not look for a way to (a wallet control port,
a test endpoint, another wallet). If the user wants a real settlement test,
they pay on the receipt page from their own wallet; afterwards the order reads
Completed.

Setup ends here. Once doctor is clean and the user has the link, your last
message starts "Setup is finished" and has at most six short lines: the
receipt page, the methods the checkout offers (Bitcoin, plus USDT, USDC, ETH
and SOL when the swap code is saved), and one line of what to look at. Do not
list each coin's availability, mention a minimum, or say a coin will not work:
a provider minimum depends on the order total, and the user's own orders will
differ. Do not list what you changed or what doctor checked. Send nothing
after it. Do not install mail software, add containers or services, or set up
cron. If doctor's "Reconcile scheduled" check fails, fix that. On a store with
little traffic, add one sentence to that message: a system cron for WordPress
scheduled work settles orders sooner, and this setup does not add one. State
it as a recommendation. Do not offer to set it up or end the message on a
question.

## Non-negotiables

- Never print, log or commit a code, never put one in a shell argument, and
  never write one into source files, wp-config.php, the database or browser
  code. Doctor's set/unset is all you report.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this store. Never read or run anything from another project or
  directory on this machine (its `node_modules`, tools or source), for any
  reason. A browser, Playwright, hand-made calls to the checkout's REST routes,
  `wp eval` and reading the plugin's source are not part of setup: when doctor
  or `test-invoice` fails, report its output.
- Receive-only NWC is required. Never turn on the spend-capable override to
  get past the preflight.
- The plugin owns only its payment-attempt tables in the WordPress database.
  EDD owns orders, prices, customers, download access and email. Do not add an
  external payment database or custom fulfillment code.
- IF SWAPS ARE ON, KEEP THE ROUTE BACK. A deposit that arrives short or late
  becomes refundable, and the customer claims it later on the same order's
  purchase confirmation page. Keep that page available, and keep the plugin
  installed while swap orders may still need a refund.
  https://openreceive.org/guides/swap-refunds.md
- A receive-only wallet cannot send merchant refunds. Refund a settled
  payment manually from the wallet.
- Settlement runs on checkout requests and an every-minute scheduled job. A
  system cron for WordPress scheduled work helps a low-traffic store, and
  `wp openreceive notifications` is an optional long-running worker: recommend
  them, and set one up only when the user asks for it by name. "Go ahead" is
  not that request.

## Further reading

- [Easy Digital Downloads Quickstart](https://openreceive.org/guides/quickstart-edd.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)

---

## The quickstart, in full

Inlined verbatim so this file needs no network access. Steps 0–3 above are the setup and this is their reference: where the two differ, the steps win, and its wp-admin screens are only for a store with no WP-CLI.
The page it comes from is https://openreceive.org/guides/quickstart-edd.

## Easy Digital Downloads quickstart

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

### Install the plugin

In **Plugins → Add New**, search for **OpenReceive**, then install and
activate it. With WP-CLI, run `wp plugin install openreceive --activate`.

Each GitHub release also attaches the plugin as a ZIP, for a site that cannot
reach WordPress.org:
[openreceive-wordpress-0.4.30.zip](https://github.com/OpenReceive/openreceive/releases/download/v0.4.30/openreceive-wordpress-0.4.30.zip).
Install it through **Plugins → Add New → Upload Plugin**. The GitHub
source-code ZIP is not an installable plugin.

### Enable GMP in both PHP runtimes

GMP is required by the bundled elliptic-curve code, in the web PHP and in the
PHP that runs WP-CLI. If the plugin is not running, the Plugins screen says
which requirement is missing. On managed hosting, ask the host to enable GMP
and sodium; [WordPress hosting requirements](https://openreceive.org/guides/wordpress-hosting.md) lists what
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

### Configure the wallet

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

### Check it

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

### How a payment works

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

### Refunds and removal

The receive-only wallet cannot send refunds. Send a refund from your own
wallet, then record it in EDD. A customer whose swap deposit never converted
reclaims it from the same order's purchase confirmation page. If you turn on
swaps, you commit to keeping that page available. See
[swap refunds](https://openreceive.org/guides/swap-refunds.md).

Deactivating or deleting the plugin keeps its two payment tables: they are a
record of payments received. (On a site that also runs WooCommerce, its
**Remove data on uninstall** setting drops them on deletion.) EDD orders are
always kept.

### Tested, and not tested

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
