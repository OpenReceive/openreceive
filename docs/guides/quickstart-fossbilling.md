# FOSSBilling quickstart

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

## Install the extension

Each GitHub release attaches the extension as a ZIP. Unzip it in FOSSBilling's
folder, the one that holds `console.php`. It adds two folders and changes no
FOSSBilling file: `modules/Openreceive`, the module (its settings page,
routes, console commands and cron hook), and
`library/Payment/Adapter/OpenReceive`, the payment gateway.

```sh
cd /var/www/fossbilling
curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.30/openreceive-fossbilling-0.4.30.zip
unzip -oq openreceive-fossbilling-0.4.30.zip
rm openreceive-fossbilling-0.4.30.zip
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

### The module-only ZIP

Each release also attaches `openreceive-fossbilling-module-<version>.zip`:
the module alone, with its files at the top of the ZIP rather than inside
`modules/Openreceive`. That is the package FOSSBilling's extension directory
installs. Its **Install** button unpacks the ZIP into `modules/Openreceive`,
and activating OpenReceive under **Extensions** then writes the payment
gateway, as above. Both ZIPs hold the same module.

### FOSSBilling in Docker

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
docker compose exec -T -u www-data fossbilling sh -c 'curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.30/openreceive-fossbilling-0.4.30.zip && unzip -oq openreceive-fossbilling-0.4.30.zip && rm openreceive-fossbilling-0.4.30.zip'
docker compose exec -T -u www-data fossbilling php modules/Openreceive/activate.php
```

Always pass `-u www-data`. A command that runs as root can leave files in
FOSSBilling's `data/` folder that the web server cannot write.

## Configure the wallet

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

## Check it

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

## How a payment works

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

## Refunds and removal

The receive-only wallet cannot send refunds. Send a refund from your own
wallet, then record it in FOSSBilling. A client whose swap deposit never
converted reclaims it from the same invoice's payment page, while the invoice
is still unpaid. If you turn on swaps, you commit to keeping that path
available. See [swap refunds](swap-refunds.md).

Deactivating the module turns its payment gateway off, because a deactivated
module serves no checkout. Activating it again turns the gateway back on when
a wallet code is saved.

Uninstalling the module keeps the two tables, which are a record of payments
received, and leaves the gateway off. Its row and its files in
`library/Payment/Adapter/OpenReceive` stay too, since FOSSBilling's invoices
and transactions refer to the gateway.

## Tested, and not tested

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

## Next

- [Swap refunds](swap-refunds.md)
- [How OpenReceive stores payments](storage.md)
- [Payment safety](payment-safety-upgrade.md)
