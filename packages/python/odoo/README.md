# OpenReceive for Odoo

Take Bitcoin Lightning payments in your [Odoo](https://www.odoo.com) shop and
on Odoo invoices, straight into your own wallet. OpenReceive is a payment
provider: the customer picks it on Odoo's own payment step, pays on a checkout
page of your shop, and Odoo confirms the order or marks the invoice paid as
with any other provider.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

Odoo owns customers, orders, invoices and prices. The module runs the
OpenReceive Python engine, which keeps payment attempts in two tables of
Odoo's own PostgreSQL database and records a settled payment by marking Odoo's
payment transaction done in the same database transaction.

Docs and setup: [Odoo quickstart](https://openreceive.org/guides/quickstart-odoo)

## Install

Requires Odoo 19 or 20, self-hosted or on Odoo.sh. Odoo Online cannot install
modules. The module needs the `openreceive` Python package at the module's
version, installed where Odoo's Python finds it.

Each GitHub release attaches `openreceive-odoo-<version>.zip`, with the module
folder `payment_openreceive` at the top. Unzip it into a folder on Odoo's
addons path, install the Python package, restart Odoo, and install
**Payment Provider: OpenReceive** under Apps.

- **Odoo.sh**: commit the module folder to your repository and add
  `openreceive==0.4.29` to the repository's `requirements.txt`.
- **Odoo's Docker image**: build your own image on top of it; the quickstart
  has the Dockerfile.
- **A source install with a virtualenv**: `pip install openreceive==0.4.29` in
  Odoo's virtualenv.

## Configure

In **Invoicing** (or **Website**) → **Configuration** → **Payment Providers**,
open **OpenReceive**. Paste a receive-only NWC code (a Nostr Wallet Connect
code that can create invoices and read payments, but not spend) and, for
stablecoins, a swap provider code. Saving asks the wallet first and keeps a
code only when the wallet answers as receive-only; the codes are never shown
again. Then publish the provider.

From a terminal, pipe each code in from a protected file, never as an
argument:

```sh
odoo openreceive configure --nwc-uri=- -d <database> < /secure/path/wallet-code
odoo openreceive configure --lsc-uri-primary=- -d <database> < /secure/path/swap-code
odoo openreceive configure --enable -d <database>
odoo openreceive doctor -d <database>
odoo openreceive test-invoice --new -d <database>
```

## License

MIT
