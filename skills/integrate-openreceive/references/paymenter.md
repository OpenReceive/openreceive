This is the full file; follow it from Step 0.

# OpenReceive agent directions (Paymenter)

```sh
# READ THIS FIRST: this file is 19 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/paymenter/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- The user only pastes codes into this chat. Never ask them to run a command, edit a file or use an admin page.
- Store each code yourself as Step 2 says. Never put a code in a shell command.
- Do not suggest rotating or revoking a code because it was pasted here.
- Setup is done only when the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".

These directions describe OpenReceive 0.4.27.

Install and configure the OpenReceive payment gateway in the Paymenter billing
panel you are working in. Preserve its theme, clients, products, invoices and
prices. The extension is one folder that bundles the PHP engine and the
checkout's script: do not install Composer or npm packages into Paymenter, and
do not clone the OpenReceive repository.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets
clients pay with USDT, USDC, ETH or SOL instead; the provider converts the
payment to BTC over Lightning in the merchant's connected wallet. Available
assets and networks depend on the provider.

Run every `php artisan` command below in Paymenter's directory, as the web
server's user, never as root: a root run can leave Paymenter's log file owned
by root, and then every page fails. With Paymenter's official Docker image,
that is `docker compose exec -T -u nginx paymenter php artisan …` (`-T` passes
stdin through; use the Paymenter service's own name). On a server, it is
`sudo -u www-data php artisan …` with the site's own user.

## Step 0 — ask for the two codes, one question at a time

Before anything else, check one thing: whether OpenReceive is already
installed (`php artisan openreceive:doctor`). If the command exists, it prints
`NWC_URI: set` or `unset` (likewise `LSC_URI_PRIMARY`), never the values. A
code that is already set is not asked for again; if both are set, skip to
Step 3.

Otherwise your next action is a question to the user. Do not download the
extension, edit Docker files or search anywhere else before asking it. Do not
read Paymenter's `.env`, deploy config, container environments or other
projects looking for a code: a new install has neither code yet.

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
   or no first. Otherwise ask whether clients should also be able to pay
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

## Step 1 — install the extension

The extension is the ZIP attached to this GitHub release. It holds one
`OpenReceive` folder, which goes into Paymenter's `extensions/Gateways/`
directory. Never install the GitHub source-code ZIP or a ZIP from an older
release. With Paymenter's official Docker image, download and unpack it inside
the container, as the web user:

```sh
docker compose exec -T -u nginx paymenter sh -c 'cd /app/extensions/Gateways && curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.27/openreceive-paymenter-0.4.27.zip && unzip -q openreceive-paymenter-0.4.27.zip && rm openreceive-paymenter-0.4.27.zip'
docker compose exec -T -u nginx paymenter php artisan app:extension:install gateway OpenReceive
```

On a server, unpack it into `<paymenter>/extensions/Gateways/` the same way,
make the folder the web user's, and run the same `app:extension:install`. That
command creates the extension's two tables in Paymenter's database and its
gateway, "Bitcoin Lightning". Checkout offers it once a wallet code is saved.

The extension needs Paymenter 1.5 or later on 64-bit PHP 8.3+ with GMP and
sodium. The official image has all of them. If doctor reports a missing PHP
extension on a server, say which one and stop: installing PHP extensions on
the user's server is theirs to decide.

## Step 2 — store the codes

Store each code yourself, one per command, and never as a shell argument:

1. Write the code with your file-editing tool, not a shell command (no
   `echo`, `printf` or heredoc), to a new file outside the Paymenter
   directory, such as `/tmp/openreceive-code`.
2. Run `php artisan openreceive:configure --nwc-uri=- < /tmp/openreceive-code`.
   In Docker: `docker compose exec -T -u nginx paymenter php artisan openreceive:configure --nwc-uri=- < /tmp/openreceive-code`.
   For the LSC code, use `--lsc-uri-primary=-`.
3. Delete the file (`rm /tmp/openreceive-code`), whether the command passed
   or not.

The command asks the wallet first and saves the code, encrypted with
Paymenter's `APP_KEY`, only when the wallet answers as receive-only; a failure
saves nothing. If it reports spend methods such as `pay_invoice`, ask the user
for a receive-only code again. Saving the swap code renames the gateway to
"Bitcoin & stablecoins". Never write a code into Paymenter's settings table,
`.env` or any file in the Paymenter directory yourself.

Then run `php artisan openreceive:doctor`. It names any failed check and exits
nonzero; fix it before going on.

## Step 3 — mint a test invoice, then stop

Create a small unpaid test invoice, billed to the first admin account without
Paymenter's new-invoice email, and mint its Lightning invoice:

```sh
php artisan openreceive:test-invoice --new
```

To use an invoice that already exists, pass its id instead of `--new`.
`test-invoice` goes through the same route as the invoice's payment dialog. It
prints the amount in sats, the BOLT11 invoice, the invoice page and the
methods the dialog offers, each swap asset marked available or followed by
the reason it is not. That reason is the answer; report it. "Below the
provider minimum" or "above the provider maximum" is about this invoice's
amount, not a fault. Only when the reason says the provider is unreachable
does doctor's "Swap provider" line have more detail. `test-invoice` and
`doctor` are the whole check.

Give the user the invoice page; its **Pay** button opens the checkout on this
same invoice. Tell them the test invoice is theirs to cancel.

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark the invoice paid, and do not look for a way to (a wallet control port, a
test endpoint, another wallet). If the user wants a real settlement test, they
pay from the invoice page with their own wallet; afterwards the invoice reads
paid.

Setup ends here. Once doctor is clean and the user has the link, your last
message starts "Setup is finished" and has at most six short lines: the
invoice page, the methods the checkout offers (Bitcoin, plus USDT, USDC, ETH
and SOL when the swap code is saved), and one line of what to look at. Do not
list each coin's availability, mention a minimum, or say a coin will not work:
a provider minimum depends on the invoice total, and real invoices will
differ. Do not list what you changed or what doctor checked. Send nothing
after it. Do not add containers, services, workers or cron jobs: Paymenter's
own cron job runs the extension's every-minute pass. If doctor says
Paymenter's scheduler has never run, say so in one line of that message.

## Non-negotiables

- Never print, log or commit a code, never put one in a shell argument, and
  never write one into source files, `.env`, the database or browser code.
  Doctor's set/unset is all you report.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this Paymenter. Never read or run anything from another project
  or directory on this machine (its `node_modules`, tools or source), for any
  reason. A browser, Playwright, hand-made calls to the checkout's routes,
  `tinker` and reading the extension's source are not part of setup: when
  doctor or `test-invoice` fails, report its output.
- Run `php artisan` as the web server's user, never as root.
- Receive-only NWC is required. Never get past the preflight with a code that
  can spend.
- The extension owns only its two payment tables in Paymenter's database.
  Paymenter owns clients, invoices, prices, services and email. Do not add an
  external payment database or custom fulfillment code, and do not edit
  Paymenter's own files.
- IF SWAPS ARE ON, KEEP THE ROUTE BACK. A deposit that arrives short or late
  becomes refundable, and the client claims it later from the same invoice's
  payment dialog. Keep the extension installed while swap payments may still
  need a refund. https://openreceive.org/guides/swap-refunds.md
- A receive-only wallet cannot send refunds. Refund a settled payment manually
  from the wallet.

## Further reading

- [Paymenter Quickstart](https://openreceive.org/guides/quickstart-paymenter.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)
- [Payment Safety Upgrade](https://openreceive.org/guides/payment-safety-upgrade.md)

---

## The quickstart, in full

Inlined verbatim so this file needs no network access. Steps 0–3 above are the setup and this is their reference: where the two differ, the steps win, and its admin-area screens are only for a Paymenter with no shell.
The page it comes from is https://openreceive.org/guides/quickstart-paymenter.

## Paymenter quickstart

[Paymenter](https://paymenter.org) is an open-source billing panel for hosting
companies. The OpenReceive extension adds a payment method to it: the client
pays an invoice with Bitcoin over Lightning, straight into your own wallet,
from Paymenter's own payment dialog. With a swap provider, the same dialog
also takes USDT, USDC, SOL and ETH, which the provider converts to BTC over
Lightning into the same wallet.

Paymenter keeps owning clients, invoices, prices and services. The extension
keeps its payment attempts in two tables of Paymenter's own database. When a
payment settles, it records the payment on the invoice with Paymenter's own
payment call, so the invoice turns paid and Paymenter activates or renews the
service as it does for any other gateway.

Requirements: Paymenter 1.5 or later, on 64-bit PHP 8.3 or later with GMP and
sodium, and MySQL or MariaDB. Paymenter's official Docker image has all of
them. Paymenter's cron job must run, as Paymenter's own install guide sets up.

### Install the extension

Each GitHub release attaches the extension as a ZIP that holds one
`OpenReceive` folder. It belongs in Paymenter's `extensions/Gateways/`
directory, next to Stripe and PayPal:

```sh
cd /var/www/paymenter
curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.27/openreceive-paymenter-0.4.27.zip
unzip -q openreceive-paymenter-0.4.27.zip -d extensions/Gateways
rm openreceive-paymenter-0.4.27.zip
chown -R www-data:www-data extensions/Gateways/OpenReceive
sudo -u www-data php artisan app:extension:install gateway OpenReceive
```

Use your own Paymenter directory and web server user. The last command creates
the extension's two tables and its gateway, named "Bitcoin Lightning". Until a
wallet code is saved, checkout does not offer it.

The ZIP already bundles the extension's dependencies and the checkout's
script, under their own prefixed names, so Composer never runs and nothing in
Paymenter's own `vendor/` changes. Paymenter updates leave the folder alone.
The GitHub source-code ZIP is not an installable extension.

#### Paymenter in Docker

The official Compose file mounts `./extensions` into the container, so unzip
into the `extensions/Gateways` folder next to `compose.yml`. Run the artisan
commands inside the container as its web user, `nginx`:

```sh
docker compose exec -u nginx paymenter php artisan app:extension:install gateway OpenReceive
```

Always pass `-u nginx`. A command that runs as root can create Paymenter's
daily log file as root, and every web request then fails with a 500 until you
fix the ownership with `chown -R nginx:nginx /app/storage`.

### Configure the wallet

You need a receive-only NWC code: a Nostr Wallet Connect code that can create
invoices and read payments but cannot spend. The extension refuses a code that
can spend.

In the admin area, open **Gateways**, edit **Bitcoin Lightning**, paste the
code into **Receive-only NWC code** and save. To accept stablecoins too, paste a
swap provider code into **Swap provider code**. Paymenter stores both
encrypted with its `APP_KEY`.

From a terminal, pipe each code into `openreceive:configure` from your secret
manager or a protected file. Never type a code as a command argument:

```sh
sudo -u www-data php artisan openreceive:configure --nwc-uri=- < /secure/path/wallet-code
sudo -u www-data php artisan openreceive:configure --lsc-uri-primary=- < /secure/path/swap-code
sudo -u www-data php artisan openreceive:doctor
```

`configure` asks the wallet first and saves the code only when it answers as a
receive-only wallet. Saving a swap code renames the default "Bitcoin Lightning"
to "Bitcoin & stablecoins"; `--name="…"` sets your own. Omit the swap command
for Bitcoin-only checkout.

`doctor` checks the gateway, GMP and sodium, each code as set or unset (never
its value), the tables, the routes, the wallet, the price feed for every
Paymenter currency, each swap provider and the scheduled pass. It exits
nonzero when a check fails.

### Check it

Make a Lightning invoice through the same route the payment dialog uses, for a
new $5 test invoice billed to the first admin account, or for any unpaid
invoice by its id:

```sh
sudo -u www-data php artisan openreceive:test-invoice --new
sudo -u www-data php artisan openreceive:test-invoice <invoice id>
```

`--new` sends no new-invoice email; `--amount=` and `--user=<email>` change
what it bills and to whom. Cancel the test invoice in the admin area when you
are done.

It prints the amount in sats, the Lightning invoice and the invoice page, then
each method the dialog offers: Bitcoin Lightning, and each swap asset with its
network and whether it is available for this amount. A small invoice is often
below a swap provider's minimum; that is the amount, not a fault.

### How a payment works

1. The client opens the invoice, presses **Pay** and picks the OpenReceive
   method. The checkout opens inside Paymenter's payment dialog.
2. The extension charges what is still due on the invoice, in the invoice's
   currency, converted to sats at the current BTC price. Only the client the
   invoice belongs to, signed in, can make or follow its payment.
3. Once the wallet reports the payment, the extension records it on the
   invoice in the same database transaction that settles it. The payment hash
   is the transaction id. Paymenter then marks the invoice paid and runs its
   usual work, such as activating the service and sending the receipt.
4. The dialog returns the client to the invoice, now paid.

The checkout asks the wallet while the dialog is open. If the client closes it
before the payment settles, the extension's pass on Paymenter's scheduler finds
the payment within a minute or so. `php artisan openreceive:reconcile` runs one
pass by hand.

A client who closes the dialog and comes back to the invoice gets the same
Lightning invoice again while it is still valid.

### Refunds and removal

The receive-only wallet cannot send refunds. Send a refund from your own
wallet, then record it in Paymenter. A client whose swap deposit never
converted reclaims it from the same invoice's payment dialog, while the invoice
is still unpaid. If you turn on swaps, you commit to keeping that path
available. See [swap refunds](https://openreceive.org/guides/swap-refunds.md).

Deleting the gateway keeps the two tables: they are a record of payments
received.

### Tested, and not tested

Tested on 2026-10-16 with Paymenter 1.5.9's official Docker image and MariaDB
11.8, a test wallet and a test swap provider: install from the built ZIP,
configure from stdin, the doctor, and a client paying an invoice by Lightning
in Chromium, after which the invoice reads paid with the payment hash as its
transaction.

Not tested: PostgreSQL or SQLite, Paymenter in a subdirectory of a domain, and
Paymenter's automatic charges of saved payment methods. Lightning cannot pull
a payment, so OpenReceive offers no saved payment method: the client pays
each renewal invoice.
