# Bitcoin payments in Odoo, through BTCPay Server

Odoo takes the payment through BTCPay Server's own Odoo add-on, and BTCPay
takes it with the OpenReceive plugin. Each order is paid over Lightning into
the wallet you connect to BTCPay. There is no OpenReceive account and no API
key, and nothing holds your funds on the way.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure in BTCPay converts the payment to **BTC over
Lightning**, and it settles into the same wallet. Available assets and
networks depend on the provider.

You run, or rent, a BTCPay Server. Without one, OpenReceive's own Odoo
module takes the payment in Odoo itself: see the
[Odoo quickstart](quickstart-odoo.md).

## What we test

An automated test runs this route end to end on one machine:
`npm run trial:btcpay-route -- --store odoo` in the OpenReceive repository.
It starts a stock BTCPay Server 2.4.5, installs the OpenReceive plugin from
BTCPay's Plugin Directory, and connects a test wallet. Then it starts Odoo
19 Community with btcpayserver/odoo 19.0.1.1, pairs the two the way this
guide does, and buys a product. The checks: Odoo sends the buyer to a BTCPay
invoice, BTCPay marks the invoice Settled when the wallet is paid, BTCPay's
notification sets Odoo's payment done, and Odoo confirms the order. The
buyer's checkout is driven from Odoo's server, not a browser. Odoo 17 and 18
have their own branches of the add-on, which this test does not run.

## 1. Set up BTCPay Server with OpenReceive

Follow the [BTCPay Server quickstart](quickstart-btcpay.md): install the
OpenReceive plugin and connect your receive-only wallet to the store Odoo
will sell through. Make one test invoice in BTCPay before you go on.

## 2. Install the Odoo add-on

The add-on is **Payment Provider: BTCPay Server** (`payment_btcpayserver`)
from [btcpayserver/odoo](https://github.com/btcpayserver/odoo). Use the
branch for your Odoo version: `19.0`, `18.0` or `17.0`.

1. Put the `payment_btcpayserver` folder in a directory on Odoo's
   `addons_path`.
2. Install the Python package it needs on the Odoo server:
   `pip install ecdsa`. On the official Docker image, add it to your own
   image, because the image does not include it.
3. Restart Odoo. In **Apps**, update the apps list, then install
   **Payment Provider: BTCPay Server**.

## 3. Pair Odoo with your BTCPay store

The add-on uses BTCPay's access tokens, which you create in BTCPay:

1. In BTCPay, open the store, then **Settings → Access Tokens**, and create
   a token. Give it a label such as `Odoo`, leave the public key empty, and
   submit.
2. On the next page, click **Approve**. BTCPay shows a pairing code: copy it.
3. In Odoo, open **Payment Providers** (Odoo's search finds it) and open
   **BTCPay Server payments**.
4. Enter your **BTCPay Server URL**, as Odoo's server reaches it, then paste
   the **Pairing Code**. Odoo pairs at once and fills in the token. Keep the
   facade `merchant`.
5. Set the provider's state to **Enabled** and publish it. The payment
   method **Pay with Bitcoin / Lightning Network** comes with it.

## 4. Let BTCPay reach Odoo

BTCPay tells Odoo about each payment by posting to
`<your Odoo URL>/payment/btcpay/ipn`, so BTCPay must reach Odoo's address
(Odoo's `web.base.url`, under **Settings → Technical → System
Parameters**).

BTCPay Server 2.4.5 and later refuse to post to a private-network address,
such as an Odoo on the same LAN or Docker network. If yours is one, list its
host and port in BTCPay's `BTCPAY_SSRFEXCEPTIONS` setting, for example
`odoo:8069` or `10.0.0.5:8069`, and restart BTCPay. An Odoo on a public
address needs nothing.

## 5. Check it

Buy something in your shop and pay the BTCPay invoice from a Lightning
wallet. BTCPay shows the invoice **Settled**, and Odoo marks the payment
done and confirms the order.

- Each payment logs one `BTCPay: rejected notification: BTCPay: Invalid
  notification data.` line in Odoo. One of BTCPay's notifications has a shape
  the add-on skips; the next one confirms the payment.
- Odoo confirms a quotation by payment only when it does not need the
  customer's online signature. Shop orders never do; a quotation you send from
  Sales with **Online Signature** on stays a quotation until it is signed.

## Next

- [BTCPay Server quickstart](quickstart-btcpay.md): the plugin's settings,
  swaps, and what BTCPay shows the payer
- [Lightning Swap Connect](lightning-swap-connect.md): what a swap code is
