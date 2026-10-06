# OpenReceive agent directions (WordPress + WooCommerce)

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
plugin, edit Docker files or search anywhere else before asking it. PHP
extensions, Docker images and the database wait until both codes are in this
chat, or the user said "Bitcoin only"; Step 1 covers them. Do not read wp-config.php, deploy config, container environments or other projects
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
wp plugin install https://github.com/OpenReceive/openreceive/releases/download/v{{release}}/openreceive-wordpress-{{release}}.zip --activate
```

It needs WooCommerce active, and PHP 8.2+ with GMP and sodium in BOTH the web
PHP and the WP-CLI PHP. On the official `wordpress` and `wordpress:cli` Docker
images, activation fails with "OpenReceive requires the PHP sodium and GMP
extensions": add GMP to both images as "Enable GMP in both PHP runtimes" below
says, rebuild both, then install again. If the Compose file has only `image:`
lines, use the two Dockerfiles and `build:` keys under "Compose files with only
`image:` lines" below, and add no other service. If the URL answers 404, build the same
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

## Step 3 — mint a test invoice, then stop

Create a pending test order that pays with OpenReceive, then mint its
Lightning invoice from the terminal:

```sh
wp wc shop_order create --user=<admin user id> --payment_method=openreceive \
  --line_items='[{"product_id":<product id>,"quantity":1}]' --porcelain
wp openreceive test-invoice <order id>
```

`test-invoice` goes through the same checkout route as the order-pay page. It
prints the amount in sats, the BOLT11 invoice, the order-pay link and the
methods that page offers, each swap asset marked available or followed by the
reason it is not. That reason is the answer; report it. "Below the provider
minimum" or "above the provider maximum" is about this order's amount, not a
fault: a small test order is often under a swap minimum. Only when the reason
says the provider is unreachable does doctor's "Swap provider" line have more
detail. `test-invoice` and `doctor` are the whole checkout check.

Give the user the order-pay link, which opens the checkout on this same
invoice, and the list of methods. Tell them the test order is theirs to delete.

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark the order paid, and do not look for a way to (a wallet control port, a
test endpoint, another wallet). If the user wants a real settlement test, they
pay on the order-pay link from their own wallet; afterwards
`wp wc shop_order get <order id> --user=<admin user id> --field=status` is no
longer `pending`.

Setup ends here. Once doctor is clean and the user has the link, say that setup
is finished, in one message. Do not install mail software, add containers or
services, or set up cron. If doctor's "Reconcile scheduled" check fails, fix
that. On a store with little traffic, tell the user once that a system cron for
WordPress scheduled work settles orders sooner; set it up only if they ask.

## Non-negotiables

- Never print, log or commit a code, never put one in a shell argument, and
  never write one into source files, wp-config.php or browser code. Doctor's
  set/unset is all you report.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this store. Never read or run anything from another project or
  directory on this machine (its `node_modules`, tools or source), for any
  reason. A browser, Playwright, hand-made calls to the checkout's REST routes
  and reading the plugin's source are not part of setup: when doctor or
  `test-invoice` fails, report its output.
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
- Settlement runs on checkout requests and an every-minute scheduled job. A
  system cron for WordPress scheduled work helps a low-traffic store, and
  `wp openreceive notifications` is an optional long-running worker: recommend
  them, and set them up only if the user asks.

## Further reading

- [WordPress + WooCommerce Quickstart](https://openreceive.org/guides/quickstart-woocommerce.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)
- [Payment Safety Upgrade](https://openreceive.org/guides/payment-safety-upgrade.md)
