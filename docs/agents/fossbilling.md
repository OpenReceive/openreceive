This is the full file; follow it from Step 0.

# OpenReceive agent directions (FOSSBilling)

```sh
# READ THIS FIRST: this file is 24 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/fossbilling/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- The user only pastes codes into this chat. Never ask them to run a command, edit a file or use an admin page.
- Store each code yourself as Step 2 says. Never put a code in a shell command.
- Do not suggest rotating or revoking a code because it was pasted here.
- Setup is done only when the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".

These directions describe OpenReceive 0.4.29.

Install and configure the OpenReceive payment method in the FOSSBilling
billing panel you are working in. Preserve its theme, clients, products,
invoices and prices. The extension is a ZIP that bundles the PHP engine and the
checkout's script: do not install Composer or npm packages into FOSSBilling,
and do not clone the OpenReceive repository.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets
clients pay with USDT, USDC, ETH or SOL instead; the provider converts the
payment to BTC over Lightning in the merchant's connected wallet. Available
assets and networks depend on the provider.

Run every `php` command below in FOSSBilling's folder (the one that holds
`console.php`), as the web server's user, never as root: a root run can leave
files in FOSSBilling's `data/` folder that the web server cannot write. With
FOSSBilling's official Docker image, that is
`docker compose exec -T -u www-data fossbilling php console.php …` (`-T` passes
stdin through; use the FOSSBilling service's own name; the container starts in
`/var/www/html`). On a server, it is `sudo -u www-data php console.php …` with
the site's own user.

## Step 0 — ask for the two codes, one question at a time

Before anything else, check one thing: whether OpenReceive is already
installed (`php console.php openreceive:doctor`). If the command exists, it
prints `NWC_URI: set` or `unset` (likewise `LSC_URI_PRIMARY`), never the
values. A code that is already set is not asked for again; if both are set,
skip to Step 3.

Otherwise your next action is a question to the user. Do not download the
extension, edit Docker files or search anywhere else before asking it. Do not
read FOSSBilling's `config.php`, deploy config, container environments or other
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

The extension needs 64-bit PHP 8.3+ with GMP and sodium. Check first:
`php -m` must list both `gmp` and `sodium`. FOSSBilling's official Docker
image has sodium but not GMP, so with it, build an image that adds GMP:

1. Put a `Dockerfile` next to the Compose file, with the same tag as the
   FOSSBilling service's `image:` line:

   ```dockerfile
   FROM fossbilling/fossbilling:<tag>
   RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev \
    && docker-php-ext-install gmp && rm -rf /var/lib/apt/lists/*
   ```

2. In the Compose file, replace that service's `image:` line with `build: .`
   (the folder that holds the Dockerfile). Change nothing else in the file.
3. Run `docker compose up -d --build`. FOSSBilling's files and `config.php`
   stay in the service's volume; only PHP changes. Check `php -m` again.

On a server without GMP, say which PHP extension is missing and stop:
installing PHP extensions on the user's server is theirs to decide.

The extension is the ZIP attached to this GitHub release. Unzip it in
FOSSBilling's folder: it adds `modules/Openreceive` and
`library/Payment/Adapter/OpenReceive`, and changes no FOSSBilling file. Never
install the GitHub source-code ZIP or a ZIP from an older release. With the
Docker image, download and unpack it inside the container, as the web user,
then activate the module:

```sh
docker compose exec -T -u www-data fossbilling sh -c 'curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.29/openreceive-fossbilling-0.4.29.zip && unzip -oq openreceive-fossbilling-0.4.29.zip && rm openreceive-fossbilling-0.4.29.zip'
docker compose exec -T -u www-data fossbilling php modules/Openreceive/activate.php
```

On a server, unpack it in FOSSBilling's folder the same way, make the two
folders the web user's, and run the same `activate.php`. Activation writes the
payment gateway's files into `library/Payment/Adapter/OpenReceive` from the
module's own copy, creates the extension's two tables in FOSSBilling's
database and its payment gateway, "Bitcoin Lightning", hooks its reconcile
pass into FOSSBilling's cron, and makes the `openreceive:*` console commands
appear. The gateway stays off until a wallet code is saved. If `activate.php`
says that folder holds another gateway, report that and stop.

## Step 2 — store the codes

Store each code yourself, one per command, and never as a shell argument:

1. Write the code with your file-editing tool, not a shell command (no
   `echo`, `printf` or heredoc), to a new file outside the FOSSBilling
   folder, such as `/tmp/openreceive-code`.
2. Run `php console.php openreceive:configure --nwc-uri=- < /tmp/openreceive-code`.
   In Docker: `docker compose exec -T -u www-data fossbilling php console.php openreceive:configure --nwc-uri=- < /tmp/openreceive-code`.
   For the LSC code, use `--lsc-uri-primary=-`.
3. Delete the file (`rm /tmp/openreceive-code`), whether the command passed
   or not.

The command asks the wallet first and saves the code, encrypted by
FOSSBilling, only when the wallet answers as receive-only; a failure saves
nothing. If it reports spend methods such as `pay_invoice`, ask the user for a
receive-only code again. Saving the wallet code turns the payment method on;
saving the swap code renames it to "Bitcoin & stablecoins". Never write a code
into FOSSBilling's database, `config.php` or any file in the FOSSBilling
folder yourself.

Then run `php console.php openreceive:doctor`. It names any failed check and
exits nonzero; fix it before going on.

## Step 3 — mint a test invoice, then stop

Create a small unpaid test invoice, billed to a test client the command
creates once (`openreceive-test@example.invalid`, so no real client sees it
and no email reaches anyone), and mint its Lightning invoice:

```sh
php console.php openreceive:test-invoice --new
```

To use an invoice that already exists, pass its id instead of `--new`.
`test-invoice` goes through the same route as the invoice's payment page. It
prints the amount in sats, the BOLT11 invoice, the invoice page and the
methods the payment page offers, each swap asset marked available or followed
by the reason it is not. That reason is the answer; report it. "Below the
provider minimum" or "above the provider maximum" is about this invoice's
amount, not a fault. Only when the reason says the provider is unreachable
does doctor's "Swap provider" line have more detail. `test-invoice` and
`doctor` are the whole check.

Give the user the invoice page, to open in a browser where they are signed in
to FOSSBilling's admin area; choosing the payment method there opens the
checkout on this same invoice. Tell them the test invoice and the test client
are theirs to delete.

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
after it. Do not add containers, services, workers or cron jobs:
FOSSBilling's own cron job runs the extension's pass. If doctor says
FOSSBilling's cron has never run, say so in one line of that message.

## Non-negotiables

- Never print, log or commit a code, never put one in a shell argument, and
  never write one into source files, `config.php`, the database or browser
  code. Doctor's set/unset is all you report.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this FOSSBilling. Never read or run anything from another
  project or directory on this machine (its `node_modules`, tools or source),
  for any reason. A browser, Playwright, hand-made calls to the checkout's
  routes, database queries and reading the extension's source are not part
  of setup: when doctor or `test-invoice` fails, report its output.
- Run `php` as the web server's user, never as root.
- Receive-only NWC is required. Never get past the preflight with a code that
  can spend.
- The extension owns only its two payment tables in FOSSBilling's database.
  FOSSBilling owns clients, invoices, prices, services and email. Do not add
  an external payment database or custom fulfillment code, and do not edit
  FOSSBilling's own files. The Dockerfile that adds GMP and the one Compose
  line that builds it are the only deployment change.
- IF SWAPS ARE ON, KEEP THE ROUTE BACK. A deposit that arrives short or late
  becomes refundable, and the client claims it later from the same invoice's
  payment page. Keep the extension installed while swap payments may still
  need a refund. https://openreceive.org/guides/swap-refunds.md
- A receive-only wallet cannot send refunds. Refund a settled payment manually
  from the wallet.

## Further reading

- [FOSSBilling Quickstart](https://openreceive.org/guides/quickstart-fossbilling.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)

---

## The quickstart, in full

Inlined verbatim so this file needs no network access. Steps 0–3 above are the setup and this is their reference: where the two differ, the steps win, and its admin-area screens are only for a FOSSBilling with no shell.
The page it comes from is https://openreceive.org/guides/quickstart-fossbilling.

## FOSSBilling quickstart

[FOSSBilling](https://fossbilling.org) is an open-source billing panel for
hosting companies and other online services. The OpenReceive extension adds a
payment method to it: the client pays an invoice with Bitcoin over Lightning,
straight into your own wallet, on FOSSBilling's own payment page. With a swap
provider, the same page also takes USDT, USDC, SOL and ETH, which the provider
converts to BTC over Lightning into the same wallet.

FOSSBilling keeps owning clients, invoices, prices and services. The extension
keeps its payment attempts in two tables of FOSSBilling's own database. When a
payment settles, it records it the way FOSSBilling's own gateways do: a
transaction in FOSSBilling's payment log, with the payment hash as its id, and
the amount on the client's balance, in the same database transaction that
settles the payment. The balance then pays the invoice, so the invoice turns
paid and FOSSBilling activates or renews the service and sends its emails as
it does for any other gateway.

Requirements: FOSSBilling 0.8 or later, on 64-bit PHP 8.3 or later with GMP
and sodium, and FOSSBilling's MySQL or MariaDB database. FOSSBilling's cron
job must run, as its install guide sets up; the official Docker image runs it
every five minutes.

### Install the extension

Each GitHub release attaches the extension as a ZIP. Unzip it in FOSSBilling's
folder, the one that holds `console.php`. It adds two folders and changes no
FOSSBilling file: `modules/Openreceive`, the module (its settings page,
routes, console commands and cron hook), and
`library/Payment/Adapter/OpenReceive`, the payment gateway.

```sh
cd /var/www/fossbilling
curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.29/openreceive-fossbilling-0.4.29.zip
unzip -oq openreceive-fossbilling-0.4.29.zip
rm openreceive-fossbilling-0.4.29.zip
chown -R www-data:www-data modules/Openreceive library/Payment/Adapter/OpenReceive
sudo -u www-data php modules/Openreceive/activate.php
```

Use your own FOSSBilling folder and web server user. `activate.php` activates
the module the way **Extensions** in the admin area does, and you can use
either. Activation creates the extension's two tables and its payment
gateway, "Bitcoin Lightning", and hooks its reconcile pass into FOSSBilling's
cron. The gateway stays off until a wallet code is saved.

The module carries its own copy of the payment gateway and writes it into
`library/Payment/Adapter/OpenReceive` each time it is activated, so running
`activate.php` again after an update brings the gateway up to date with the
module. It replaces only OpenReceive's own gateway files: if that folder holds
anything else, activation stops and says so.

The ZIP already bundles the extension's dependencies and the checkout's
script, under their own prefixed names, so Composer never runs and nothing in
FOSSBilling's own `vendor/` changes. The GitHub source-code ZIP is not an
installable extension.

#### The module-only ZIP

Each release also attaches `openreceive-fossbilling-module-<version>.zip`:
the module alone, with its files at the top of the ZIP rather than inside
`modules/Openreceive`. That is the package FOSSBilling's extension directory
installs. Its **Install** button unpacks the ZIP into `modules/Openreceive`,
and activating OpenReceive under **Extensions** then writes the payment
gateway, as above. Both ZIPs hold the same module.

#### FOSSBilling in Docker

FOSSBilling's official image has sodium but not GMP. Build your own image on
top of it: put this `Dockerfile` next to your `compose.yml`, use the same tag
as your image,

```dockerfile
FROM fossbilling/fossbilling:0.8.8
RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev \
 && docker-php-ext-install gmp && rm -rf /var/lib/apt/lists/*
```

and in `compose.yml` replace the FOSSBilling service's `image:` line with
`build: .`, then run `docker compose up -d --build`. FOSSBilling's files,
its `config.php` and the extension stay in the named volume at
`/var/www/html`; only PHP changes.

Run every command inside the container, in `/var/www/html`, as its web user
`www-data`. Unpack the release there too:

```sh
docker compose exec -T -u www-data fossbilling sh -c 'curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.29/openreceive-fossbilling-0.4.29.zip && unzip -oq openreceive-fossbilling-0.4.29.zip && rm openreceive-fossbilling-0.4.29.zip'
docker compose exec -T -u www-data fossbilling php modules/Openreceive/activate.php
```

Always pass `-u www-data`. A command that runs as root can leave files in
FOSSBilling's `data/` folder that the web server cannot write.

### Configure the wallet

You need a receive-only NWC code: a Nostr Wallet Connect code that can create
invoices and read payments but cannot spend. The extension refuses a code that
can spend.

In the admin area, open **Extensions**, then the settings (gear) button on
**OpenReceive**. Paste the code into **Receive-only NWC code** and save. To
accept stablecoins too, paste a swap provider code into **Swap provider
code**. FOSSBilling stores both encrypted with its install's salt, and the page
never shows them again; it says only whether each is set.

From a terminal, pipe each code into `openreceive:configure` from your secret
manager or a protected file. Never type a code as a command argument:

```sh
sudo -u www-data php console.php openreceive:configure --nwc-uri=- < /secure/path/wallet-code
sudo -u www-data php console.php openreceive:configure --lsc-uri-primary=- < /secure/path/swap-code
sudo -u www-data php console.php openreceive:doctor
```

The settings page and `configure` both ask the wallet first and save the code
only when it answers as a receive-only wallet. Saving the wallet code turns
the payment method on. Saving a swap code renames the default "Bitcoin
Lightning" to "Bitcoin & stablecoins"; the settings page's name field, or
`--name="…"`, sets your own. Skip the swap code for Bitcoin-only checkout.

`doctor` checks the module, GMP and sodium, each code as set or unset (never
its value), the payment gateway's files and row, the tables, the checkout's
files, the wallet,
the price feed for every FOSSBilling currency, each swap provider and the cron
hook with FOSSBilling's last cron run. It exits nonzero when a check fails.

### Check it

Make a Lightning invoice through the same route the payment page uses, for a
new $5 test invoice, or for any unpaid invoice by its id:

```sh
sudo -u www-data php console.php openreceive:test-invoice --new
sudo -u www-data php console.php openreceive:test-invoice <invoice id>
```

`--new` bills a test client that it creates once,
`openreceive-test@example.invalid`, so no real client sees the invoice and no
email reaches anyone. `--amount=` and `--client=<email>` change what it bills
and to whom. Delete the test invoice, or the test client, in the admin area
when you are done.

It prints the amount in sats, the Lightning invoice and the invoice page, then
each method the payment page offers: Bitcoin Lightning, and each swap asset
with its network and whether it is available for this amount. A small invoice
is often below a swap provider's minimum; that is the amount, not a fault. The
invoice page opens in a browser that is signed in to the admin area.

### How a payment works

1. The client picks the OpenReceive method when checking out an order, or on
   an unpaid invoice's page, and FOSSBilling opens its payment page with the
   checkout on it.
2. The extension charges the invoice's total with tax, in the invoice's
   currency, converted to sats at the current BTC price. FOSSBilling decides
   who may open the payment page: the client the invoice belongs to, an admin,
   or anyone holding the invoice's link when you allow paying from the link
   (FOSSBilling's own invoice setting). Only that browser session can make or
   follow the invoice's payment.
3. Once the wallet reports the payment, the extension records the transaction
   and the client's balance in the same database transaction that settles it.
   Right after, the balance pays the invoice, and FOSSBilling runs its usual
   work, such as activating the service and sending the receipt. Should that
   last step fail, the amount stays on the client's balance, and FOSSBilling's
   cron pays the client's unpaid invoices from it on its next run.
4. The checkout returns the client to the invoice, now paid.

The checkout asks the wallet while the payment page is open. If the client
closes it before the payment settles, the extension's pass on FOSSBilling's
cron finds the payment on the next run. `php console.php openreceive:reconcile`
runs one pass by hand.

A client who leaves and comes back to the invoice gets the same Lightning
invoice again while it is still valid.

Routine lines go to FOSSBilling's `data/log/billing` log. Warnings and errors
also appear under **Activity** in the admin area.

### Refunds and removal

The receive-only wallet cannot send refunds. Send a refund from your own
wallet, then record it in FOSSBilling. A client whose swap deposit never
converted reclaims it from the same invoice's payment page, while the invoice
is still unpaid. If you turn on swaps, you commit to keeping that path
available. See [swap refunds](https://openreceive.org/guides/swap-refunds.md).

Deactivating the module turns its payment gateway off, because a deactivated
module serves no checkout. Activating it again turns the gateway back on when
a wallet code is saved.

Uninstalling the module keeps the two tables, which are a record of payments
received, and leaves the gateway off. Its row and its files in
`library/Payment/Adapter/OpenReceive` stay too, since FOSSBilling's invoices
and transactions refer to the gateway.

### Tested, and not tested

Tested on 2026-10-16 with FOSSBilling 0.8.8's official Docker image with GMP
added, MariaDB 11.8, a test wallet and a test swap provider: install from the
built ZIP, `activate.php`, configure from stdin and from the settings page,
the doctor, and a client ordering a product and paying by Lightning and by
USDT on Solana in Chromium, after which the invoice reads paid and the
service is active. A payment whose page was closed was recorded by
FOSSBilling's cron. Another client, a visitor and a request without the page's
security token were refused.

Tested on 2026-10-18 in the same setup: the module-only ZIP installed through
FOSSBilling's own **Install** and **Activate** buttons in the admin area, with
the extension directory's answer for OpenReceive supplied locally, then the
same checks. Deactivating, activating again, uninstalling, reinstalling and
updating a 0.4.28 install with `activate.php` were checked too. On
FOSSBilling 0.8.0, the oldest release the module accepts: the same install
and activation, `configure`, the doctor, `test-invoice --new`, deactivating
and activating again.

Not tested: FOSSBilling behind nginx rather than its image's Apache, shared
hosting without a shell, and FOSSBilling's subscription payments. Lightning
cannot pull a payment, so OpenReceive offers no subscriptions: the client
pays each renewal invoice.
