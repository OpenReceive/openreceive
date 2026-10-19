This is the full file; follow it from Step 0.

# OpenReceive agent directions (Odoo)

```sh
# READ THIS FIRST: this file is 23 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/odoo/full.md
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

Install and configure the OpenReceive payment provider in the Odoo you are
working in. Preserve its website, customers, products, orders, invoices and
prices. The module is a ZIP; its Python side is the `openreceive` package from
PyPI at the same version. Do not install anything else into Odoo, do not
change Odoo's own files, and do not clone the OpenReceive repository.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets
customers pay with USDT, USDC, ETH or SOL instead; the provider converts the
payment to BTC over Lightning in the merchant's connected wallet. Available
assets and networks depend on the provider.

The module needs Odoo 19 or 20. With Odoo's official Docker image, run Odoo's
commands through the image's entrypoint, which adds the database connection:
`docker compose exec -T odoo /entrypoint.sh odoo …` (`-T` passes stdin
through; use the Odoo service's own name). `-d <database>` names the
database; `docker compose exec -T db psql -U <user> -l` lists them when you
do not know it. On a server, run `odoo …` (or `odoo-bin …`) as Odoo's own
user with its config file (`-c`).

## Step 0 — ask for the two codes, one question at a time

Before anything else, check one thing: whether OpenReceive is already
installed (`odoo openreceive doctor -d <database>`). If the command exists, it
prints `NWC_URI: present-redacted` or `missing` (likewise the LSC
connections), never the values. A code that is already saved is not asked for
again; if both are saved, skip to Step 3.

Otherwise your next action is a question to the user. Do not download the
module, edit Docker files or search anywhere else before asking it. Do not
read Odoo's config file, its database, container environments or other
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

The `openreceive` Python package must be importable by Odoo's own Python.
Odoo's official Docker image keeps its packages under the system's package
manager, so build an image that adds it:

1. Put a `Dockerfile` next to the Compose file, with the same tag as the Odoo
   service's `image:` line:

   ```dockerfile
   FROM odoo:<tag>
   USER root
   RUN pip3 install --no-cache-dir --break-system-packages --ignore-installed typing_extensions h11 \
    && pip3 install --no-cache-dir --break-system-packages openreceive==0.4.30
   USER odoo
   ```

   The first line installs two packages beside the system's copies, which pip
   cannot replace; do not add other packages, and do not install
   `cryptography`: Odoo keeps using the system's.
2. In the Compose file, replace that service's `image:` line with `build: .`
   (the folder that holds the Dockerfile). Change nothing else in the file.
3. Run `docker compose up -d --build`.

On a server, install `openreceive==0.4.30` with the pip of the Python
that runs Odoo (its virtualenv when it has one). On Odoo.sh, add
`openreceive==0.4.30` to the repository's `requirements.txt`. If you
cannot tell which Python runs Odoo, say so and stop.

The module is the ZIP attached to this GitHub release, with its folder,
`payment_openreceive`, at the top. Unzip it into the folder Odoo reads extra
modules from: with the official image, the host folder mounted at
`/mnt/extra-addons` (the Compose file's `volumes:` says which); on a server, a
folder on the config file's `addons_path`. Never install the GitHub
source-code ZIP or a ZIP from an older release.

```sh
curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.30/openreceive-odoo-0.4.30.zip
unzip -oq openreceive-odoo-0.4.30.zip -d <that folder> && rm openreceive-odoo-0.4.30.zip
```

Then install it into the database and restart Odoo:

```sh
docker compose exec -T odoo /entrypoint.sh odoo -d <database> -i payment_openreceive --stop-after-init --no-http
docker compose restart odoo
```

Installing creates the module's two tables in Odoo's database, its payment
provider "OpenReceive" with the payment method "Bitcoin Lightning", a
scheduled action that records payments made after the customer left, and the
`odoo openreceive` command. The provider stays hidden from customers until a
wallet code is saved and Step 2 publishes it. If the install says the
`openreceive` package is missing, the image or virtualenv from the step above
is not the one Odoo runs: fix that, do not work around it.

## Step 2 — store the codes

Store each code yourself, one per command, and never as a shell argument:

1. Write the code with your file-editing tool, not a shell command (no
   `echo`, `printf` or heredoc), to a new file outside the Odoo folders, such
   as `/tmp/openreceive-code`.
2. Run `odoo openreceive configure --nwc-uri=- -d <database> < /tmp/openreceive-code`.
   In Docker: `docker compose exec -T odoo /entrypoint.sh odoo openreceive configure --nwc-uri=- -d <database> < /tmp/openreceive-code`.
   For the LSC code, use `--lsc-uri-primary=-`.
3. Delete the file (`rm /tmp/openreceive-code`), whether the command passed
   or not.

The command asks the wallet first and saves the code, in the module's own
table, only when the wallet answers as receive-only; a failure saves nothing.
If it reports spend methods such as `pay_invoice`, ask the user for a
receive-only code again. Saving the swap code renames the payment method to
"Bitcoin & stablecoins". Never write a code into Odoo's database, its config
file or any file in its folders yourself.

Then publish the provider, in every company:
`odoo openreceive configure --enable -d <database>`, and run
`odoo openreceive doctor -d <database>`. Doctor names any failed check and
exits nonzero; fix it before going on.

## Step 3 — mint a test invoice, then stop

Create a small draft payment transaction for a test contact the command
creates once (`openreceive-test@example.invalid`, with no order, so no
customer sees it), and mint its Lightning invoice:

```sh
odoo openreceive test-invoice --new -d <database>
```

To use a transaction that already exists, pass `--reference <its reference>`
instead of `--new`. `test-invoice` goes through the same route as the
checkout page. It prints the amount in sats, the BOLT11 invoice and the
methods the checkout offers, each swap asset marked available or followed by
the reason it is not. That reason is the answer; report it. A reason about the
provider's minimum or maximum is about this amount, not a fault. `test-invoice`
and `doctor` are the whole check.

The checkout page itself belongs to the customer who starts a payment: tell
the user to try it from the shop, by putting a product in the cart and paying
with "Bitcoin Lightning" (or "Bitcoin & stablecoins").

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark the transaction paid, and do not look for a way to (a wallet control
port, a test endpoint, another wallet). If the user wants a real settlement
test, they pay a shop order with their own wallet; afterwards the order is
confirmed.

Setup ends here. Once doctor is clean, your last message starts "Setup is
finished" and has at most six short lines: the methods the checkout offers
(Bitcoin, plus USDT, USDC, ETH and SOL when the swap code is saved), and one
line of what to try in the shop. Do not list each coin's availability, mention
a minimum, or say a coin will not work: a provider minimum depends on the
order total, and real orders will differ. Do not list what you changed or
what doctor checked. Send nothing after it. Do not add containers, services,
workers or cron jobs: the module's scheduled action runs inside Odoo.

## Non-negotiables

- Never print, log or commit a code, never put one in a shell argument, and
  never write one into source files, Odoo's config file, the database or
  browser code. Doctor's present/missing is all you report.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this Odoo. Never read or run anything from another project or
  directory on this machine (its `node_modules`, tools or source), for any
  reason. A browser, Playwright, hand-made calls to the checkout's routes,
  database queries and reading the module's source are not part of setup:
  when doctor or `test-invoice` fails, report its output.
- Receive-only NWC is required. Never get past the preflight with a code that
  can spend.
- The module owns only its two payment tables and its settings table in
  Odoo's database. Odoo owns customers, orders, invoices, prices and email.
  Do not add an external payment database or custom fulfillment code, and do
  not edit Odoo's own files or modules. The Dockerfile that adds the Python
  package and the one Compose line that builds it are the only deployment
  change.
- IF SWAPS ARE ON, KEEP THE ROUTE BACK. A deposit that arrives short or late
  becomes refundable, and the customer claims it later from the same
  transaction's checkout page. Keep the module installed while swap payments
  may still need a refund. https://openreceive.org/guides/swap-refunds.md
- A receive-only wallet cannot send refunds. Refund a settled payment manually
  from the wallet.

## Further reading

- [Odoo Quickstart](https://openreceive.org/guides/quickstart-odoo.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)

---

## The quickstart, in full

Inlined verbatim so this file needs no network access. Steps 0–3 above are the setup and this is their reference: where the two differ, the steps win, and its provider-form screens are only for an Odoo with no shell.
The page it comes from is https://openreceive.org/guides/quickstart-odoo.

## Odoo quickstart

[Odoo](https://www.odoo.com) runs shops, sales and invoicing. The OpenReceive
module adds a payment provider to it: the customer pays an online order, or an
invoice's payment link, with Bitcoin over Lightning, straight into your own
wallet, on a checkout page of your own site. With a swap provider, the same
page also takes USDT, USDC, SOL and ETH, which the provider converts to BTC
over Lightning into the same wallet.

Odoo keeps owning customers, orders, invoices and prices. The module keeps its
payment attempts in two tables of Odoo's own PostgreSQL database. When a
payment settles, it marks Odoo's payment transaction done in the same database
transaction that settles the payment, then runs Odoo's own post-processing:
the order is confirmed, or the invoice paid, and Odoo sends its emails as it
does for any other provider.

Requirements: Odoo 19 or 20, self-hosted or on Odoo.sh, and the `openreceive`
Python package at the module's version. Odoo Online cannot install modules, so
it cannot run this one. A shop that already runs BTCPay Server can use
[Odoo via BTCPay Server](https://openreceive.org/guides/odoo.md) instead.

### Install the module

Each GitHub release attaches the module as `openreceive-odoo-<version>.zip`,
with its folder, `payment_openreceive`, at the top. Unzip it into a folder on
Odoo's addons path, install the Python package where Odoo's Python finds it,
restart Odoo, and install **Payment Provider: OpenReceive** under **Apps**, or
from a terminal:

```sh
cd /path/to/your/addons
curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.30/openreceive-odoo-0.4.30.zip
unzip -oq openreceive-odoo-0.4.30.zip && rm openreceive-odoo-0.4.30.zip
odoo -d <database> -i payment_openreceive --stop-after-init
```

How the Python package gets in depends on how Odoo runs:

- **Odoo.sh**: commit the `payment_openreceive` folder to your repository and
  add `openreceive==0.4.30` to the repository's `requirements.txt`.
- **A source install with a virtualenv**: `pip install openreceive==0.4.30`
  in Odoo's virtualenv.
- **Odoo's Docker image** or **its Debian package**: see below.

Installing the module creates its two tables, its payment provider,
"OpenReceive", with the payment method buyers pick, "Bitcoin Lightning", and a
scheduled action that records payments made after the customer left. The
provider stays hidden from customers until a wallet code is saved and you
publish it.

#### Odoo in Docker

Odoo's official image keeps its Python packages under the system's package
manager. Build your own image on top of it: put this `Dockerfile` next to your
`compose.yml`, with the same tag as your image,

```dockerfile
FROM odoo:19.0
USER root
RUN pip3 install --no-cache-dir --break-system-packages --ignore-installed typing_extensions h11 \
 && pip3 install --no-cache-dir --break-system-packages openreceive==0.4.30
USER odoo
```

and in `compose.yml` replace the Odoo service's `image:` line with
`build: .`, then run `docker compose up -d --build`. The first `pip3` line
installs two packages beside the system's own copies, which pip cannot
replace; Odoo keeps using the system's other packages, its `cryptography`
included. Your database and the module folder you mount at
`/mnt/extra-addons` stay as they are.

Run Odoo's commands through the image's entrypoint, which adds the database
connection: `docker compose exec odoo /entrypoint.sh odoo <arguments>`. To
install the module from a terminal:

```sh
docker compose exec odoo /entrypoint.sh odoo -d <database> -i payment_openreceive --stop-after-init --no-http
docker compose restart odoo
```

### Configure the wallet

You need a receive-only NWC code: a Nostr Wallet Connect code that can create
invoices and read payments but cannot spend. The module refuses a code that
can spend.

In **Invoicing** (or **Website**) → **Configuration** → **Payment Providers**,
open **OpenReceive**. Paste the code into **Receive-only NWC code** and save.
To accept stablecoins too, paste a swap provider code into **Swap provider
code**. Saving asks the wallet first and keeps the code only when the wallet
answers as receive-only. The codes go to the module's own table, which no Odoo
screen lists, and the form never shows them again; it says only whether each
is saved. Then publish the provider (Odoo 19: State **Enabled**; Odoo 20:
**Live** and **Published**).

From a terminal, pipe each code into `odoo openreceive configure` from your
secret manager or a protected file. Never type a code as a command argument:

```sh
odoo openreceive configure --nwc-uri=- -d <database> < /secure/path/wallet-code
odoo openreceive configure --lsc-uri-primary=- -d <database> < /secure/path/swap-code
odoo openreceive configure --enable -d <database>
odoo openreceive doctor -d <database>
```

In Docker, start each with `docker compose exec -T odoo /entrypoint.sh`; `-T`
passes the file through. `--enable` publishes the provider in every company.
Saving a swap code renames the payment method "Bitcoin & stablecoins"; a name
you gave it yourself stays. Skip the swap code for Bitcoin-only checkout.

`doctor` checks the module and the Python package versions, each code as set
or unset (never its value), the wallet, the tables, the provider in each
company, the payment method, the checkout's files, the scheduled action, the
price feed for each company's currency and the swap provider. It exits nonzero
when a check fails.

One wallet serves the whole database: every company's OpenReceive provider
uses the codes saved last.

### Check it

Make a Lightning invoice through the same route the checkout page uses, for a
new $5 test transaction, or for any unpaid OpenReceive transaction by its
reference:

```sh
odoo openreceive test-invoice --new -d <database>
odoo openreceive test-invoice --reference S00012-1 -d <database>
```

`--new` creates a draft payment transaction for a test contact it creates
once, `openreceive-test@example.invalid`, with no order behind it, so no
customer sees it. `--amount=` changes the amount, in the company's currency.
It prints the amount in sats, the Lightning invoice, then each method the
checkout offers: Bitcoin Lightning, and each swap asset with its network and
whether it is available for this amount. A small amount is often below a swap
provider's minimum; that is the amount, not a fault.

### How a payment works

1. The customer picks OpenReceive on Odoo's payment step, at checkout or on an
   invoice's payment link, and clicks **Pay**. Odoo creates its payment
   transaction and sends the customer to the module's checkout page for it.
2. The module charges the transaction's amount, in its currency, converted to
   sats at the current BTC price. Only the browser session that started the
   payment can see its checkout page and make or follow its invoice: Odoo
   records that transaction in the session, as its own payment status page
   does.
3. Once the wallet reports the payment, the module marks the transaction done
   and runs Odoo's post-processing in the same database transaction that
   settles it: the order is confirmed or the invoice paid. Should the
   post-processing fail, the transaction stays done and Odoo's own scheduled
   action finishes it.
4. The checkout takes the customer to Odoo's payment status page, which takes
   them on to the order's confirmation.

The checkout asks the wallet while the page is open. If the customer closes it
before the payment settles, the module's scheduled action finds the payment
within a minute. `odoo openreceive reconcile -d <database>` runs one pass by
hand.

A customer who reloads the checkout page gets the same Lightning invoice
again while it is still valid. Paying again from the order starts a new Odoo
transaction with its own invoice; the earlier invoice still counts if paid.

Odoo's log records each settlement under `odoo.addons.payment_openreceive`.

### Refunds and removal

The receive-only wallet cannot send refunds. Send a refund from your own
wallet, then record it in Odoo. A customer whose swap deposit never converted
reclaims it from the same transaction's checkout page, while the transaction
is still unpaid. If you turn on swaps, you commit to keeping that path
available. See [swap refunds](https://openreceive.org/guides/swap-refunds.md).

Uninstalling the module deletes the saved codes and keeps the two payment
tables, which are a record of payments received. Odoo keeps the provider and
its transactions, as it does for any provider whose module is removed.

### Tested, and not tested

Tested on 2026-10-19 with Odoo 19 and Odoo 20 from their official Docker
images, PostgreSQL 17, a test wallet and a test swap provider: install from
the built ZIP, configure from stdin and from the provider form, the doctor,
`test-invoice --new`, and a signed-in customer ordering through the shop and
paying by Lightning and by USDT on Solana in Chromium, after which the sale
order is confirmed. A payment whose page was closed was recorded by the
scheduled action. Another customer, a visitor and a request without Odoo's
CSRF token were refused. The module's own tests run on both series.

Not tested: Odoo.sh, Odoo's Debian package, paying an invoice from its
payment link, multi-company shops, and Odoo 18 or older, which the module does
not install on. Lightning cannot pull a payment, so
OpenReceive offers no subscriptions or saved payment tokens.
