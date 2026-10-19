# OpenReceive agent directions (Odoo)

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
    && pip3 install --no-cache-dir --break-system-packages openreceive=={{release}}
   USER odoo
   ```

   The first line installs two packages beside the system's copies, which pip
   cannot replace; do not add other packages, and do not install
   `cryptography`: Odoo keeps using the system's.
2. In the Compose file, replace that service's `image:` line with `build: .`
   (the folder that holds the Dockerfile). Change nothing else in the file.
3. Run `docker compose up -d --build`.

On a server, install `openreceive=={{release}}` with the pip of the Python
that runs Odoo (its virtualenv when it has one). On Odoo.sh, add
`openreceive=={{release}}` to the repository's `requirements.txt`. If you
cannot tell which Python runs Odoo, say so and stop.

The module is the ZIP attached to this GitHub release, with its folder,
`payment_openreceive`, at the top. Unzip it into the folder Odoo reads extra
modules from: with the official image, the host folder mounted at
`/mnt/extra-addons` (the Compose file's `volumes:` says which); on a server, a
folder on the config file's `addons_path`. Never install the GitHub
source-code ZIP or a ZIP from an older release.

```sh
curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v{{release}}/openreceive-odoo-{{release}}.zip
unzip -oq openreceive-odoo-{{release}}.zip -d <that folder> && rm openreceive-odoo-{{release}}.zip
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
- [Payment Safety Upgrade](https://openreceive.org/guides/payment-safety-upgrade.md)
