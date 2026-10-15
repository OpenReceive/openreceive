# Bitcoin payments in PrestaShop, through BTCPay Server

PrestaShop takes the payment through BTCPay Server's own PrestaShop module,
and BTCPay takes it with the OpenReceive plugin. Each order is paid over
Lightning into the wallet you connect to BTCPay. There is no OpenReceive
account and no API key, and nothing holds your funds on the way.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure in BTCPay converts the payment to **BTC over
Lightning**, and it settles into the same wallet. Available assets and
networks depend on the provider.

You run, or rent, a BTCPay Server. The module is for PrestaShop 8 and 9; we
test it on PrestaShop 9.2.0.

## What we test

An automated test runs this route end to end on one machine:
`npm run trial:btcpay-route -- --store prestashop` in the OpenReceive
repository. It starts a stock BTCPay Server 2.4.5, installs the OpenReceive
plugin from BTCPay's Plugin Directory, and connects a test wallet. Then it
installs PrestaShop 9.2.0 from its official Docker image with
btcpayserver/prestashop-plugin 6.3.3. It gives the module a BTCPay key with
exactly the permissions the module asks for, and a guest checks out. The
checks: the module creates its webhook in BTCPay, the checkout offers **Pay
with BTCPay Server**, the module's payment step creates a BTCPay invoice and
the order, BTCPay marks the invoice Settled when the wallet is paid, and
BTCPay's webhook moves the order to **Paid with crypto** with its full total
paid. The test saves the key the way the module's configuration page does,
and runs the checkout inside PrestaShop, not in a browser, so the redirects
to BTCPay and back are not part of it.

## 1. Set up BTCPay Server with OpenReceive

Follow the [BTCPay Server quickstart](quickstart-btcpay.md): install the
OpenReceive plugin and connect your receive-only wallet to the store
PrestaShop will sell through. Make one test invoice in BTCPay before you go
on.

## 2. Install the module

1. Download `btcpay.zip` from the module's
   [releases](https://github.com/btcpayserver/prestashop-plugin/releases).
2. In the PrestaShop back office, open **Modules → Module Manager**, click
   **Upload a module**, and choose the zip.
3. When it is installed, click **Configure**.

## 3. Connect PrestaShop to your BTCPay store

1. Enter the **BTCPay Server URL**, with `https://`, and click **Save**.
   PrestaShop sends you to BTCPay, which asks you to approve a key for the
   module: view and modify the store's settings, modify its webhooks, and
   create, view and modify invoices.
2. Choose the one store PrestaShop sells through, and click **Authorize
   app**. BTCPay sends you back to PrestaShop with the key.
3. The module checks that the store has a payment method, which the
   OpenReceive plugin's Lightning gives it, and creates BTCPay's webhook to
   PrestaShop. **Server Information** on the module's page then shows the
   webhook **Enabled**.

If the way back to PrestaShop fails, open **Account → API Keys** in BTCPay,
copy the new key, and paste it into **BTCPay Server API key** on the
module's page.

## 4. Let BTCPay reach PrestaShop

BTCPay tells PrestaShop about each payment by posting to
`<your shop's URL>/module/btcpay/webhook` (or
`index.php?fc=module&module=btcpay&controller=webhook` with friendly URLs
off), so BTCPay must reach that address.

BTCPay Server 2.4.5 and later refuse to post to a private-network address,
such as a PrestaShop on the same LAN or Docker network. If yours is one, list
its host and port in BTCPay's `BTCPAY_SSRFEXCEPTIONS` setting, for example
`prestashop:80` or `10.0.0.5:443`, and restart BTCPay. A shop on a public
address needs nothing.

## 5. Check it

Buy something in your shop and choose **Pay with BTCPay Server**. PrestaShop
sends you to the BTCPay invoice. Pay it from a Lightning wallet. BTCPay shows
the invoice **Settled**, and PrestaShop moves the order to **Paid with
crypto**.

- The module creates the order when the buyer is sent to BTCPay, in
  **Awaiting crypto payment**. **Order creation method** on the module's page
  can wait for the payment instead.
- PrestaShop offers **Pay with BTCPay Server** only while BTCPay reports its
  Bitcoin node fully synced.

## Next

- [BTCPay Server quickstart](quickstart-btcpay.md): the plugin's settings,
  swaps, and what BTCPay shows the payer
- [Lightning Swap Connect](lightning-swap-connect.md): what a swap code is
