# Odoo quickstart

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
[Odoo via BTCPay Server](odoo.md) instead.

## Install the module

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

### Odoo in Docker

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

## Configure the wallet

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

## Check it

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

## How a payment works

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

## Refunds and removal

The receive-only wallet cannot send refunds. Send a refund from your own
wallet, then record it in Odoo. A customer whose swap deposit never converted
reclaims it from the same transaction's checkout page, while the transaction
is still unpaid. If you turn on swaps, you commit to keeping that path
available. See [swap refunds](swap-refunds.md).

Uninstalling the module deletes the saved codes and keeps the two payment
tables, which are a record of payments received. Odoo keeps the provider and
its transactions, as it does for any provider whose module is removed.

## Tested, and not tested

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

## Next

- [Swap refunds](swap-refunds.md)
- [How OpenReceive stores payments](storage.md)
- [Payment safety](payment-safety-upgrade.md)
