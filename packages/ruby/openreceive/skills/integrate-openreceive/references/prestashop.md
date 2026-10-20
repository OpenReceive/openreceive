This is the full file; follow it from Step 0.

# OpenReceive agent directions (PrestaShop)

```sh
# READ THIS FIRST: this file is 25 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/prestashop/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- The user only pastes codes into this chat. Never ask them to run a command, edit a file or use an admin page.
- Store each code yourself as Step 2 says. Never put a code in a shell command.
- Do not suggest rotating or revoking a code because it was pasted here.
- Setup is done only when the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".

These directions describe OpenReceive 0.4.31.

Install and configure the OpenReceive payment module in the PrestaShop store
you are working in. Preserve its theme, customers, products, orders and
prices. The module is a ZIP that bundles the PHP engine and the checkout's
script: do not install Composer or npm packages into PrestaShop, and do not
clone the OpenReceive repository.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets
customers pay with USDT, USDC, ETH or SOL instead; the provider converts the
payment to BTC over Lightning in the merchant's connected wallet. Available
assets and networks depend on the provider.

Run every `php` command below in PrestaShop's folder (the one that holds
`bin/console`), as the web server's user, never as root: a root run can leave
files in PrestaShop's `var/cache` that the web server cannot write. With
PrestaShop's official Docker image, that is
`docker compose exec -T -u www-data prestashop php bin/console …` (`-T` passes
stdin through; use the PrestaShop service's own name; the container starts in
`/var/www/html`). On a server, it is `sudo -u www-data php bin/console …` with
the site's own user.

## Step 0 — ask for the two codes, one question at a time

Before anything else, check one thing: whether OpenReceive is already
installed (`php bin/console openreceive:doctor`). If the command exists, it
prints `NWC_URI: set` or `unset` (likewise `LSC_URI_PRIMARY`), never the
values. A code that is already set is not asked for again; if both are set,
skip to Step 3.

Otherwise your next action is a question to the user. Do not download the
module, edit Docker files or search anywhere else before asking it. Do not
read PrestaShop's `app/config/parameters.php`, deploy config, container
environments or other projects looking for a code: a new install has neither
code yet.

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

## Step 1 — install the module

The module needs PrestaShop 9 on 64-bit PHP 8.2+ with GMP and sodium. Check
first: `php -m` must list both `gmp` and `sodium`. PrestaShop's official
Docker image has sodium but not GMP, so with it, build an image that adds GMP:

1. Put a `Dockerfile` next to the Compose file, with the same tag as the
   PrestaShop service's `image:` line:

   ```dockerfile
   FROM prestashop/prestashop:<tag>
   RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev \
    && docker-php-ext-install gmp && rm -rf /var/lib/apt/lists/*
   ```

2. In the Compose file, replace that service's `image:` line with `build: .`
   (the folder that holds the Dockerfile). Change nothing else in the file.
3. Run `docker compose up -d --build`. PrestaShop's files and configuration
   stay in the service's volume; only PHP changes. Check `php -m` again.

On a server without GMP, say which PHP extension is missing and stop:
installing PHP extensions on the user's server is theirs to decide. On
PrestaShop 8, whose PHP stops at 8.1, say the module needs PrestaShop 9 and
stop.

The module is the ZIP attached to this GitHub release, one `openreceive`
folder. Unzip it into PrestaShop's `modules` folder; it changes no PrestaShop
file. Never install the GitHub source-code ZIP or a ZIP from an older release.
With the Docker image, download and unpack it inside the container, as the
web user, then install the module with PrestaShop's own console:

```sh
docker compose exec -T -u www-data prestashop sh -c 'curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.31/openreceive-prestashop-0.4.31.zip && unzip -oq openreceive-prestashop-0.4.31.zip -d modules && rm openreceive-prestashop-0.4.31.zip'
docker compose exec -T -u www-data prestashop php bin/console prestashop:module install openreceive
```

On a server, unpack it into `modules` the same way, make `modules/openreceive`
the web user's, and run the same `prestashop:module install openreceive`.
Installing creates the module's two tables in PrestaShop's database and its
order state, "Awaiting Bitcoin payment", adds the payment option to checkout
and makes the `openreceive:*` console commands appear. The option stays
hidden until a wallet code is saved.

## Step 2 — store the codes

Store each code yourself, one per command, and never as a shell argument:

1. Write the code with your file-editing tool, not a shell command (no
   `echo`, `printf` or heredoc), to a new file outside the PrestaShop
   folder, such as `/tmp/openreceive-code`.
2. Run `php bin/console openreceive:configure --nwc-uri=- < /tmp/openreceive-code`.
   In Docker: `docker compose exec -T -u www-data prestashop php bin/console openreceive:configure --nwc-uri=- < /tmp/openreceive-code`.
   For the LSC code, use `--lsc-uri-primary=-`.
3. Delete the file (`rm /tmp/openreceive-code`), whether the command passed
   or not.

The command asks the wallet first and saves the code, encrypted with the
shop's own key, only when the wallet answers as receive-only; a failure saves
nothing. If it reports spend methods such as `pay_invoice`, ask the user for a
receive-only code again. Saving the wallet code turns the payment option on;
saving the swap code renames it to "Bitcoin & stablecoins". Never write a code
into PrestaShop's database, `app/config/parameters.php` or any file in the
PrestaShop folder yourself.

Then run `php bin/console openreceive:doctor`. It names any failed check and
exits nonzero; fix it before going on.

## Step 3 — mint a test invoice, then stop

Place a small test order for a hidden test product, bought by a test
customer the command creates once (`openreceive-test@example.invalid`, so no
real customer sees it and no email reaches anyone), and mint its Lightning
invoice:

```sh
php bin/console openreceive:test-invoice --new
```

To use an order that already awaits its OpenReceive payment, pass its id
instead of `--new`. `test-invoice` goes through the same route as the order's
confirmation page. It prints the amount in sats, the BOLT11 invoice, the
order's confirmation page and the methods the checkout offers, each swap asset
marked available or followed by the reason it is not. That reason is the
answer; report it. "Below the provider minimum" or "above the provider
maximum" is about this order's amount, not a fault. Only when the reason says
the provider is unreachable does doctor's "Swap provider" line have more
detail. `test-invoice` and `doctor` are the whole check.

Give the user the order's confirmation page, which opens the checkout on this
same invoice in any browser. Tell them to cancel the test order under
**Orders** when they are done: PrestaShop keeps every order.

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark the order paid, and do not look for a way to (a wallet control port, a
test endpoint, another wallet). If the user wants a real settlement test, they
pay from the order's page with their own wallet; afterwards the order reads
"Payment accepted".

Setup ends here. Once doctor is clean and the user has the link, your last
message starts "Setup is finished" and has at most six short lines: the
order's page, the methods the checkout offers (Bitcoin, plus USDT, USDC, ETH
and SOL when the swap code is saved), the cron line below, and one line of
what to look at. Do not list each coin's availability, mention a minimum, or
say a coin will not work: a provider minimum depends on the order total, and
real orders will differ. Do not list what you changed or what doctor checked.
Send nothing after it.

PrestaShop has no scheduler, so the module's pass for customers who leave the
page before their payment settles needs one cron line, every five minutes:
`php bin/console openreceive:reconcile` as the web user. Give the user that
line in your last message; do not add it yourself, and do not add containers,
services or workers.

## Non-negotiables

- Never print, log or commit a code, never put one in a shell argument, and
  never write one into source files, `app/config/parameters.php`, the
  database or browser code. Doctor's set/unset is all you report.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this PrestaShop. Never read or run anything from another
  project or directory on this machine (its `node_modules`, tools or source),
  for any reason. A browser, Playwright, hand-made calls to the checkout's
  routes, database queries and reading the module's source are not part of
  setup: when doctor or `test-invoice` fails, report its output.
- Run `php` as the web server's user, never as root.
- Receive-only NWC is required. Never get past the preflight with a code that
  can spend.
- The module owns only its two payment tables in PrestaShop's database.
  PrestaShop owns customers, orders, prices, carriers and email. Do not add an
  external payment database or custom fulfillment code, and do not edit
  PrestaShop's own files or theme. The Dockerfile that adds GMP and the one
  Compose line that builds it are the only deployment change.
- IF SWAPS ARE ON, KEEP THE ROUTE BACK. A deposit that arrives short or late
  becomes refundable, and the customer claims it later from the same order's
  page. Keep the module installed while swap payments may still need a
  refund. https://openreceive.org/guides/swap-refunds.md
- A receive-only wallet cannot send refunds. Refund a settled payment manually
  from the wallet.

## Further reading

- [PrestaShop Quickstart](https://openreceive.org/guides/quickstart-prestashop.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)

---

## The quickstart, in full

Inlined verbatim so this file needs no network access. Steps 0–3 above are the setup and this is their reference: where the two differ, the steps win, and its back-office screens are only for a PrestaShop with no shell.
The page it comes from is https://openreceive.org/guides/quickstart-prestashop.

## PrestaShop quickstart

[PrestaShop](https://prestashop-project.org) is an open-source e-commerce
platform. The OpenReceive module adds a payment option to it: the customer
pays with Bitcoin over Lightning, straight into your own wallet, on
PrestaShop's own order confirmation page. With a swap provider, the same page
also takes USDT, USDC, SOL and ETH, which the provider converts to BTC over
Lightning into the same wallet.

PrestaShop keeps owning customers, orders, prices and carriers. The module
keeps its payment attempts in two tables of PrestaShop's own database. When a
payment settles, it records it the way PrestaShop's payment modules do: an
order payment with the payment hash as its transaction id, in the same
database transaction that settles the payment. The order then moves to
PrestaShop's "Payment accepted", so PrestaShop makes the invoice, emails the
customer and runs its other modules as it does for any other payment.

Requirements: PrestaShop 9, on 64-bit PHP 8.2 or later with GMP and sodium,
and PrestaShop's MySQL or MariaDB database. PrestaShop 8 runs on PHP 8.1 at
most, below what the module needs. A cron job runs the module's reconcile
pass, as [below](#the-cron-job).

Already run BTCPay Server? [PrestaShop via BTCPay Server](https://openreceive.org/guides/prestashop.md) is
the other way in: BTCPay's own PrestaShop module, with OpenReceive inside
BTCPay.

### Install the module

Each GitHub release attaches the module as a ZIP with one folder,
`openreceive`. In the back office, open **Modules → Module Manager**, click
**Upload a module** and drop the ZIP in: PrestaShop unpacks it into
`modules/openreceive` and installs it.

From a shell, unzip it into PrestaShop's `modules` folder instead, and
install it with PrestaShop's own console, in the folder that holds `bin/console`:

```sh
cd /var/www/html
curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.31/openreceive-prestashop-0.4.31.zip
unzip -oq openreceive-prestashop-0.4.31.zip -d modules
rm openreceive-prestashop-0.4.31.zip
chown -R www-data:www-data modules/openreceive
sudo -u www-data php bin/console prestashop:module install openreceive
```

Use your own PrestaShop folder and web server user. Installing creates the
module's two tables and its order state, "Awaiting Bitcoin payment", and adds
the payment option to checkout. The option stays hidden until a wallet code is
saved.

The ZIP already bundles the module's dependencies and the checkout's script,
under their own prefixed names, so Composer never runs and nothing in
PrestaShop's own `vendor/` changes. The GitHub source-code ZIP is not an
installable module.

#### PrestaShop in Docker

PrestaShop's official image has sodium but not GMP. Build your own image on
top of it: put this `Dockerfile` next to your `compose.yml`, use the same tag
as your image,

```dockerfile
FROM prestashop/prestashop:9.2.0-apache
RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev \
 && docker-php-ext-install gmp && rm -rf /var/lib/apt/lists/*
```

and in `compose.yml` replace the PrestaShop service's `image:` line with
`build: .`, then run `docker compose up -d --build`. PrestaShop's files, its
configuration and the module stay in the named volume at `/var/www/html`; only
PHP changes.

Run every command inside the container, in `/var/www/html`, as its web user
`www-data`. Unpack the release there too:

```sh
docker compose exec -T -u www-data prestashop sh -c 'curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.31/openreceive-prestashop-0.4.31.zip && unzip -oq openreceive-prestashop-0.4.31.zip -d modules && rm openreceive-prestashop-0.4.31.zip'
docker compose exec -T -u www-data prestashop php bin/console prestashop:module install openreceive
```

Always pass `-u www-data`. A command that runs as root can leave files in
PrestaShop's `var/cache` that the web server cannot write.

### Configure the wallet

You need a receive-only NWC code: a Nostr Wallet Connect code that can create
invoices and read payments but cannot spend. The module refuses a code that
can spend.

In the back office, open **Modules → Module Manager** and click **Configure**
on **OpenReceive**. Paste the code into **Receive-only NWC code** and save. To
accept stablecoins too, paste a swap provider code into **Swap provider
code**. PrestaShop stores both encrypted with the shop's own key, and the page
never shows them again; it says only whether each is set.

From a terminal, pipe each code into `openreceive:configure` from your secret
manager or a protected file. Never type a code as a command argument:

```sh
sudo -u www-data php bin/console openreceive:configure --nwc-uri=- < /secure/path/wallet-code
sudo -u www-data php bin/console openreceive:configure --lsc-uri-primary=- < /secure/path/swap-code
sudo -u www-data php bin/console openreceive:doctor
```

The settings page and `configure` both ask the wallet first and save the code
only when it answers as a receive-only wallet. Saving the wallet code turns
the payment option on. Saving a swap code renames the default "Bitcoin
Lightning" to "Bitcoin & stablecoins"; the settings page's **Payment option
name**, or `--name="…"`, sets your own. Skip the swap code for Bitcoin-only
checkout. Checkout offers the option in the currencies ticked for OpenReceive
under **Payment → Preferences**; installing ticks them all.

`doctor` checks the module, PHP and its GMP and sodium, each code as set or
unset (never its value), the order state, the payment option and its
currencies, the tables, the checkout's files, the wallet, the price feed for
every currency the shop sells in, each swap provider, and when the wallet was
last scanned. It exits nonzero when a check fails.

### The cron job

PrestaShop has no scheduler of its own. While a customer has an order's page
open, its checkout records the payment the moment it settles. For a customer
who closes the page first, run the module's reconcile pass every five minutes
from cron, as the web server's user:

```cron
*/5 * * * * www-data php /var/www/html/bin/console openreceive:reconcile
```

That line goes in `/etc/cron.d/`; in the web user's own crontab, leave out
`www-data`. On hosting with a control panel, add a cron job with the same
`php …/bin/console openreceive:reconcile` command. With Docker, the host's cron
runs `docker compose exec -T -u www-data prestashop php bin/console openreceive:reconcile`
from the Compose project's folder.

Each pass also finishes any order whose payment settled but which did not
move to "Payment accepted", and every checkout request runs one pass too.

### Check it

Make a Lightning invoice through the same route the order page uses, for a
new $5 test order, or for any order awaiting its OpenReceive payment by its id:

```sh
sudo -u www-data php bin/console openreceive:test-invoice --new
sudo -u www-data php bin/console openreceive:test-invoice <order id>
```

`--new` places an order for a hidden, downloadable test product, bought by a
test customer it creates once, `openreceive-test@example.invalid`, so no real
customer sees the order and its email reaches no one. `--amount=` changes
what it costs. PrestaShop keeps every order: cancel the test order under
**Orders** when you are done. Like any new order, it may reach the back
office's notifications.

It prints the amount in sats, the Lightning invoice and the order's
confirmation page, then each method the checkout offers: Bitcoin Lightning,
and each swap asset with its network and whether it is available for this
amount. A small order is often below a swap provider's minimum; that is the
amount, not a fault. The order's confirmation page carries the order's secret
key, so it opens the checkout in any browser.

### How a payment works

1. The customer picks the OpenReceive option at checkout and places the
   order. PrestaShop creates the order in "Awaiting Bitcoin payment" and opens
   its order confirmation page with the checkout on it.
2. The module charges the order's total with tax and shipping, in the order's
   currency, converted to sats at the current BTC price. Only the customer the
   order belongs to, signed in, or a browser PrestaShop already showed the
   order to (its confirmation page, which needs the order's secret key, or
   guest order tracking) may make or follow its payment, and only from a page
   with the order's checkout, whose token comes back with each request.
3. Once the wallet reports the payment, the module records an order payment
   for it, with the payment hash as its transaction id, in the same database
   transaction that settles it. Right after, the order moves to "Payment
   accepted": PrestaShop makes the invoice, emails the customer and runs its
   other modules' hooks. Should that step fail, the next pass finishes it.
4. The page loads again and says the payment was received.

A customer who leaves can come back from **Order history** in their account,
or a guest from **Guest order tracking**: the order's page shows the
checkout again while the order awaits its payment, with the same Lightning
invoice while it is still valid.

An unpaid order stays in "Awaiting Bitcoin payment" until you cancel it, as
with any other payment that never came. If you cancel an order and its
payment arrives afterwards, the module records the payment on the order,
leaves the order cancelled, and logs a warning.

Every line the module logs goes to PrestaShop's `var/logs/openreceive.log`.
Warnings and errors also appear under **Advanced Parameters → Logs** in the
back office.

### Refunds and removal

The receive-only wallet cannot send refunds. Send a refund from your own
wallet, then record it in PrestaShop. A customer whose swap deposit never
converted reclaims it from the same order's page, while the order still
awaits its payment. If you turn on swaps, you commit to keeping that path
available. See [swap refunds](https://openreceive.org/guides/swap-refunds.md).

Disabling the module hides the payment option and its checkout. Uninstalling
it also forgets both codes. It keeps the two tables, which are a record of
payments received, and the "Awaiting Bitcoin payment" order state, which
orders refer to.

### Tested, and not tested

Tested on 2026-10-19 with PrestaShop 9.2.0's official Docker image with GMP
added (PHP 8.5), its Hummingbird theme, MariaDB 11.8, a test wallet and a
test swap provider: the module uploaded through **Upload a module** in the
back office, and installed from the unzipped ZIP with `bin/console
prestashop:module install`; the swap code saved on the Configure page and
both codes from stdin; the doctor; `test-invoice --new`; and in Chromium, a
signed-in customer checking out with OpenReceive and paying on the order
confirmation page by Lightning and by USDT on Solana, after which each order
reads "Payment accepted" with its invoice. Coming back to the order through
**Order history** resumed the same Lightning invoice. Another customer, with
an order of their own, and a visitor were refused. A payment that settled
with no page open was recorded by `openreceive:reconcile`. Uninstalling kept
the payment records and the order state and forgot the codes.

Not tested: PrestaShop 9.0 and 9.1, the Classic theme, nginx with PHP-FPM,
shared hosting, multistore, friendly URLs turned off, guest checkout and guest
order tracking, carts PrestaShop splits into several orders, and updating
from an older release of the module.
