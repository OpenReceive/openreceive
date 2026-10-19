# Bitcoin payments in Magento, through BTCPay Server

Magento takes the payment through BTCPay Server's own Magento module, and
BTCPay takes it with the OpenReceive plugin. Each order is paid over
Lightning into the wallet you connect to BTCPay. There is no OpenReceive
account and no API key, and nothing holds your funds on the way.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure in BTCPay converts the payment to **BTC over
Lightning**, and it settles into the same wallet. Available assets and
networks depend on the provider.

You run, or rent, a BTCPay Server. The module is for Magento 2.4 (Open
Source and Adobe Commerce); we test it on Mage-OS, Magento's open-source
fork, built on Magento 2.4.9.

## What we test

An automated test runs this route end to end on one machine:
`npm run trial:btcpay-route -- --store magento` in the OpenReceive
repository. It starts a stock BTCPay Server 2.4.5, installs the OpenReceive
plugin from BTCPay's Plugin Directory, and connects a test wallet. Then it
installs Mage-OS 3.6 (Magento 2.4.9) with btcpayserver/magento2-btcpay-module
2.0.12 and connects it the way this guide does. A guest checks out with
**Pay with Bitcoin**. The checks: BTCPay's webhook to Magento exists, the
module sends the buyer to a BTCPay invoice, BTCPay marks the invoice Settled
when the wallet is paid, and BTCPay's webhook makes Magento invoice the order
for its full total. The checkout runs through Magento's REST API and the
module's own redirect step, not a browser.

## 1. Set up BTCPay Server with OpenReceive

Follow the [BTCPay Server quickstart](quickstart-btcpay.md): install the
OpenReceive plugin and connect your receive-only wallet to the store
Magento will sell through. Make one test invoice in BTCPay before you go on.

## 2. Install the Magento module

From your Magento root:

```sh
composer require btcpayserver/magento2-btcpay-module
bin/magento module:enable Storefront_BTCPay
bin/magento setup:upgrade
```

On a store in production mode, also run `bin/magento setup:di:compile` and
`bin/magento setup:static-content:deploy`, as after any module.

## 3. Connect Magento to your BTCPay store

In the Magento admin, open **Stores → Configuration → Sales → Payment
Methods → BTC Pay Server**:

1. Enter the **BTCPay Base Url**, as Magento's server reaches it, and save.
2. Click **Generate API Key**. Magento sends you to BTCPay, which asks you to
   approve a key for exactly the permissions the module needs: create, view
   and modify invoices, view the store's settings, and modify its webhooks.
   Approve it, and BTCPay sends you back. Use this key. The module refuses an
   unrestricted key, and the payment method stays hidden until it has the
   right one.
3. Choose the BTCPay **Store** for this Magento store view, and save. Saving
   it creates BTCPay's webhook to Magento.
4. Refresh Magento's cache (**System → Cache Management**, or
   `bin/magento cache:clean config`). The module checks each webhook's
   signature against the cached configuration, and until the cache is
   refreshed every webhook fails, so orders wait for the module's cron job
   instead.

## 4. Let BTCPay reach Magento

BTCPay tells Magento about each payment by posting to
`<your store's secure base URL>rest/V2/btcpay/webhook`, so BTCPay must reach
that address.

BTCPay Server 2.4.5 and later refuse to post to a private-network address,
such as a Magento on the same LAN or Docker network. If yours is one, list its
host and port in BTCPay's `BTCPAY_SSRFEXCEPTIONS` setting, for example
`magento:80` or `10.0.0.5:443`, and restart BTCPay. A store on a public
address needs nothing. If a webhook is ever missed, the module's cron job
checks open invoices every five minutes.

## 5. Check it

Buy something in your store and choose **Pay with Bitcoin**. After **Place
Order**, Magento sends you to the BTCPay invoice. Pay it from a Lightning
wallet. BTCPay shows the invoice **Settled**, and Magento invoices the order
for its full total.

## Next

- [BTCPay Server quickstart](quickstart-btcpay.md): the plugin's settings,
  swaps, and what BTCPay shows the payer
- [Lightning Swap Connect](lightning-swap-connect.md): what a swap code is
