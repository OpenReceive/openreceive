# Paymenter quickstart

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

## Install the extension

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

### Paymenter in Docker

The official Compose file mounts `./extensions` into the container, so unzip
into the `extensions/Gateways` folder next to `compose.yml`. Run the artisan
commands inside the container as its web user, `nginx`:

```sh
docker compose exec -u nginx paymenter php artisan app:extension:install gateway OpenReceive
```

Always pass `-u nginx`. A command that runs as root can create Paymenter's
daily log file as root, and every web request then fails with a 500 until you
fix the ownership with `chown -R nginx:nginx /app/storage`.

## Configure the wallet

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

## Check it

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

## How a payment works

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

## Refunds and removal

The receive-only wallet cannot send refunds. Send a refund from your own
wallet, then record it in Paymenter. A client whose swap deposit never
converted reclaims it from the same invoice's payment dialog, while the invoice
is still unpaid. If you turn on swaps, you commit to keeping that path
available. See [swap refunds](swap-refunds.md).

Deleting the gateway keeps the two tables: they are a record of payments
received.

## Tested, and not tested

Tested on 2026-10-16 with Paymenter 1.5.9's official Docker image and MariaDB
11.8, a test wallet and a test swap provider: install from the built ZIP,
configure from stdin, the doctor, and a client paying an invoice by Lightning
in Chromium, after which the invoice reads paid with the payment hash as its
transaction.

Not tested: PostgreSQL or SQLite, Paymenter in a subdirectory of a domain, and
Paymenter's automatic charges of saved payment methods. Lightning cannot pull
a payment, so OpenReceive offers no saved payment method: the client pays
each renewal invoice.

## Next

- [Swap refunds](swap-refunds.md)
- [How OpenReceive stores payments](storage.md)
- [Payment safety](payment-safety-upgrade.md)
