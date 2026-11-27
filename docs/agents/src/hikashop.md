# OpenReceive agent directions (HikaShop)

Install and configure the OpenReceive payment plugin in the Joomla site with
HikaShop you are working in. Preserve its template, customers, products,
orders and prices. The plugin is a Joomla package ZIP that bundles the PHP
engine and the checkout's script: do not install Composer or npm packages into
Joomla, and do not clone the OpenReceive repository.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets
customers pay with USDT, USDC, ETH or SOL instead; the provider converts the
payment to BTC over Lightning in the merchant's connected wallet. Available
assets and networks depend on the provider.

Run every `php` command below in Joomla's folder (the one that holds
`cli/joomla.php`), as the web server's user, never as root: a root run can
leave files in Joomla's cache that the web server cannot write. With Joomla's
official Docker image, that is
`docker compose exec -T -u www-data joomla php cli/joomla.php …` (`-T` passes
stdin through; use the Joomla service's own name; the container starts in
`/var/www/html`). On a server, it is `sudo -u www-data php cli/joomla.php …`
with the site's own user.

## Step 0 — ask for the two codes, one question at a time

Before anything else, check one thing: whether OpenReceive is already
installed (`php cli/joomla.php openreceive:doctor`; without the package it
answers that the command is not defined, which means not installed). If it
exists, it prints `NWC_URI: set` or `unset` (likewise `LSC_URI_PRIMARY`),
never the values. A code that is already set is not asked for again; if both
are set, skip to Step 3.

Otherwise your next action is a question to the user. Do not download the
package, edit Docker files or search anywhere else before asking it. Do not
read Joomla's `configuration.php`, HikaShop's settings, deploy config,
container environments or other projects looking for a code: a new install
has neither code yet.

The user never runs a command. They paste each code into this chat; you
store it. That is the supported path: do not ask them to run the save
command themselves, and do not tell them to revoke or replace a
code because it was pasted here. Ask one question per message.

If you will not take a code pasted in chat, end that same message with this
in place of "Paste the code here": "Save the code alone in
`/tmp/openreceive-nwc`, then reply saved." (`/tmp/openreceive-lsc` for the
swap code). Step 2 then reads that file in place of `/tmp/openreceive-code`
and deletes it. Ask once per code: if the file is missing after their reply,
do not ask again; say which file is missing, and stop. Never print it.

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
   ETH, SOL or coins other than Bitcoin (as in "Bitcoin and stablecoin
   payments"), this message IS the walkthrough below: do not skip it, and do
   not ask yes or no first. Otherwise ask whether customers should also be
   able to pay with USDT, USDC, ETH or SOL, then give the walkthrough. The
   walkthrough:

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

## Step 1 — install the package

The package needs Joomla 5 or 6 with HikaShop 6 (the free Starter edition is
enough), on 64-bit PHP 8.2+ with GMP and sodium. Check first: `php -m` must
list both `gmp` and `sodium`. Joomla's official Docker images have both. On a
server without one of them, say which PHP extension is missing and stop:
installing PHP extensions on the user's server is theirs to decide. Without
HikaShop, say the package is a HikaShop payment method and stop: installing
HikaShop is the merchant's decision.

The package is the ZIP attached to this GitHub release. Install it with
Joomla's own console; it changes no Joomla or HikaShop file. Never install
the GitHub source-code ZIP or a ZIP from an older release. With the Docker
image, download it inside the container, as the web user:

```sh
docker compose exec -T -u www-data joomla sh -c 'cd /tmp && curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v{{release}}/openreceive-hikashop-{{release}}.zip'
docker compose exec -T -u www-data joomla php cli/joomla.php extension:install --path=/tmp/openreceive-hikashop-{{release}}.zip
docker compose exec -T -u www-data joomla rm /tmp/openreceive-hikashop-{{release}}.zip
```

On a server, download it to a temporary folder the same way and run the same
`extension:install --path=…` with its full path. Installing adds two plugins,
both enabled: the HikaShop payment method and its `openreceive:*` console
commands. It also creates the package's two tables in Joomla's database. The
payment method stays hidden at checkout until a wallet code is saved.

## Step 2 — store the codes

Store each code yourself, one per command, and never as a shell argument:

1. Write the code with your file-editing tool, not a shell command (no
   `echo`, `printf` or heredoc), to a new file outside the Joomla folder,
   such as `/tmp/openreceive-code`.
2. Run `php cli/joomla.php openreceive:configure --nwc-uri=- < /tmp/openreceive-code`.
   In Docker: `docker compose exec -T -u www-data joomla php cli/joomla.php openreceive:configure --nwc-uri=- < /tmp/openreceive-code`.
   For the LSC code, use `--lsc-uri-primary=-`.
3. Delete the file (`rm /tmp/openreceive-code`), whether the command passed
   or not.

The command asks the wallet first and saves the code, sealed with a key from
the site's own secret, only when the wallet answers as receive-only; a
failure saves nothing. If it reports spend methods such as `pay_invoice`, ask
the user for a receive-only code again. The first run also makes the HikaShop
payment method customers pick, "Bitcoin Lightning", or "Bitcoin &
stablecoins" when the swap code is saved first. Never write a code into
Joomla's database, `configuration.php` or any file in the Joomla folder
yourself.

Then run `php cli/joomla.php openreceive:doctor`. It names any failed check
and exits nonzero; fix it before going on.

## Step 3 — mint a test invoice, then stop

Place a small test order with one line and no product, for a test customer
the command creates once (`openreceive-test@example.invalid`, with no Joomla
account, so nobody signs in as it and no email reaches anyone), and mint its
Lightning invoice:

```sh
php cli/joomla.php openreceive:test-invoice --new --amount 20.00 --live-site=https://the.shop.example/
```

`--amount 20.00` (in the shop's main currency) keeps the test order above the
swap providers' minimums, so the user can try every method on the link you
give them. `--live-site` takes the shop's own address, so the printed link
names it; leave it out when Joomla's `configuration.php` sets `$live_site`.
End the address with `/`, port included (`http://127.0.0.1:8080/`): Joomla's
console joins it to `cli/joomla.php` as written, and without the slash it
fails with "Could not parse the requested URI".

To use an unpaid OpenReceive order, pass its id instead of `--new`.
`test-invoice` goes through the same route as the order's thank-you page. It
prints the amount in sats, the BOLT11 invoice, the order's thank-you page and
the methods the checkout offers, each swap asset marked available or followed
by the reason it is not. That reason is for you, not the user: it says whether
anything is wrong, and the last message names no minimum. "Below the provider
minimum" or "above the provider maximum" is about this order's amount, not a
fault. Only when the reason says the provider is unreachable does doctor's
"Swap provider" line have more detail. `test-invoice` and `doctor` are the
whole check.

Give the user the order's thank-you page, which opens the checkout on this
same invoice in any browser. Tell them to cancel the test order under
**Orders** in HikaShop when they are done: HikaShop keeps every order.

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark the order paid, and do not look for a way to (a wallet control port, a
test endpoint, another wallet). If the user wants a real settlement test, they
pay from the order's page with their own wallet; afterwards the order reads
"Confirmed".

Setup ends here. Once doctor is clean and the user has the link, your last
message starts "Setup is finished" and has at most six short lines: the
order's page, the methods the checkout offers (Bitcoin, plus USDT, USDC, ETH
and SOL when the swap code is saved), the crontab entry below, and one line of
what to look at. Do not list each coin's availability, mention a minimum, or
say a coin will not work: a provider minimum depends on the order total, and
real orders will differ. Do not list what you changed or what doctor checked.
Send nothing after it.

Joomla and HikaShop run nothing between page views, so the plugin's pass for
customers who leave the page before their payment settles needs one crontab
entry. Give the user the whole entry in your last message, with this site's
real folder, and do not add it yourself, or any containers, services or
workers. Under Docker, for the host's crontab:
`*/5 * * * * cd /path/to/shop && docker compose exec -T -u www-data joomla php cli/joomla.php openreceive:reconcile`.
Otherwise, for the web user's crontab:
`*/5 * * * * php /path/to/joomla/cli/joomla.php openreceive:reconcile`.
Until it runs, doctor's Reconcile line says the cron line never ran and the
payment method's page shows a warning. That is expected, not something to fix.

## Non-negotiables

- Never print, log or commit a code, never put one in a shell argument, and
  never write one into source files, `configuration.php`, the database or
  browser code. Doctor's set/unset is all you report.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this Joomla site. Never read or run anything from another
  project or directory on this machine (its `node_modules`, tools or source),
  for any reason. A browser, Playwright, hand-made calls to the checkout's
  routes, database queries and reading the plugin's source are not part of
  setup: when doctor or `test-invoice` fails, report its output.
- Run `php` as the web server's user, never as root.
- Receive-only NWC is required. Never get past the preflight with a code that
  can spend.
- The plugin owns only its two payment tables in Joomla's database and its
  three settings in HikaShop's configuration. HikaShop owns customers,
  orders, prices, shipping and email. Do not add an external payment database
  or custom fulfillment code, and do not edit Joomla's or HikaShop's own files
  or the template.
- IF SWAPS ARE ON, KEEP THE ROUTE BACK. A deposit that arrives short or late
  becomes refundable, and the customer claims it later from the same order's
  page. Keep the package installed while swap payments may still need a
  refund. https://openreceive.org/guides/swap-refunds.md
- A receive-only wallet cannot send refunds. Refund a settled payment manually
  from the wallet.

## Further reading

- [HikaShop Quickstart](https://openreceive.org/guides/quickstart-hikashop.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)
