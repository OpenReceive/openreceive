# PrestaShop quickstart

[PrestaShop](https://prestashop-project.org) is an open-source e-commerce
platform. The OpenReceive module adds a payment option to it: the customer
pays with Bitcoin over Lightning, straight into your own wallet, on
PrestaShop's own order confirmation page. With a swap provider, the same page
also takes USDT, USDC, SOL and ETH, which the provider converts to BTC over
Lightning into the same wallet.

PrestaShop keeps owning customers, orders, prices and carriers. The module
keeps its payment attempts in two tables of PrestaShop's own database. When a
payment settles, it records it the way PrestaShop's payment modules do: an
order payment with the payment hash as its transaction id, in the same
database transaction that settles the payment. The order then moves to
PrestaShop's "Payment accepted", so PrestaShop makes the invoice, emails the
customer and runs its other modules as it does for any other payment.

Requirements: PrestaShop 9, on 64-bit PHP 8.2 or later with GMP and sodium,
and PrestaShop's MySQL or MariaDB database. PrestaShop 8 runs on PHP 8.1 at
most, below what the module needs. A cron job runs the module's reconcile
pass, as [below](#the-cron-job).

Already run BTCPay Server? [PrestaShop via BTCPay Server](prestashop.md) is
the other way in: BTCPay's own PrestaShop module, with OpenReceive inside
BTCPay.

## Install the module

Each GitHub release attaches the module as a ZIP with one folder,
`openreceive`. In the back office, open **Modules → Module Manager**, click
**Upload a module** and drop the ZIP in: PrestaShop unpacks it into
`modules/openreceive` and installs it.

From a shell, unzip it into PrestaShop's `modules` folder instead, and
install it with PrestaShop's own console, in the folder that holds `bin/console`:

```sh
cd /var/www/html
curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.31/openreceive-prestashop-0.4.31.zip
unzip -oq openreceive-prestashop-0.4.31.zip -d modules
rm openreceive-prestashop-0.4.31.zip
chown -R www-data:www-data modules/openreceive
sudo -u www-data php bin/console prestashop:module install openreceive
```

Use your own PrestaShop folder and web server user. Installing creates the
module's two tables and its order state, "Awaiting Bitcoin payment", and adds
the payment option to checkout. The option stays hidden until a wallet code is
saved.

The ZIP already bundles the module's dependencies and the checkout's script,
under their own prefixed names, so Composer never runs and nothing in
PrestaShop's own `vendor/` changes. The GitHub source-code ZIP is not an
installable module.

### PrestaShop in Docker

PrestaShop's official image has sodium but not GMP. Build your own image on
top of it: put this `Dockerfile` next to your `compose.yml`, use the same tag
as your image,

```dockerfile
FROM prestashop/prestashop:9.2.0-apache
RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev \
 && docker-php-ext-install gmp && rm -rf /var/lib/apt/lists/*
```

and in `compose.yml` replace the PrestaShop service's `image:` line with
`build: .`, then run `docker compose up -d --build`. PrestaShop's files, its
configuration and the module stay in the named volume at `/var/www/html`; only
PHP changes.

Run every command inside the container, in `/var/www/html`, as its web user
`www-data`. Unpack the release there too:

```sh
docker compose exec -T -u www-data prestashop sh -c 'curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.31/openreceive-prestashop-0.4.31.zip && unzip -oq openreceive-prestashop-0.4.31.zip -d modules && rm openreceive-prestashop-0.4.31.zip'
docker compose exec -T -u www-data prestashop php bin/console prestashop:module install openreceive
```

Always pass `-u www-data`. A command that runs as root can leave files in
PrestaShop's `var/cache` that the web server cannot write.

## Configure the wallet

You need a receive-only NWC code: a Nostr Wallet Connect code that can create
invoices and read payments but cannot spend. The module refuses a code that
can spend.

In the back office, open **Modules → Module Manager** and click **Configure**
on **OpenReceive**. Paste the code into **Receive-only NWC code** and save. To
accept stablecoins too, paste a swap provider code into **Swap provider
code**. PrestaShop stores both encrypted with the shop's own key, and the page
never shows them again; it says only whether each is set.

From a terminal, pipe each code into `openreceive:configure` from your secret
manager or a protected file. Never type a code as a command argument:

```sh
sudo -u www-data php bin/console openreceive:configure --nwc-uri=- < /secure/path/wallet-code
sudo -u www-data php bin/console openreceive:configure --lsc-uri-primary=- < /secure/path/swap-code
sudo -u www-data php bin/console openreceive:doctor
```

The settings page and `configure` both ask the wallet first and save the code
only when it answers as a receive-only wallet. Saving the wallet code turns
the payment option on. Saving a swap code renames the default "Bitcoin
Lightning" to "Bitcoin & stablecoins"; the settings page's **Payment option
name**, or `--name="…"`, sets your own. Skip the swap code for Bitcoin-only
checkout. Checkout offers the option in the currencies ticked for OpenReceive
under **Payment → Preferences**; installing ticks them all.

`doctor` checks the module, PHP and its GMP and sodium, each code as set or
unset (never its value), the order state, the payment option and its
currencies, the tables, the checkout's files, the wallet, the price feed for
every currency the shop sells in, each swap provider, and when the wallet was
last scanned. It exits nonzero when a check fails.

## The cron job

PrestaShop has no scheduler of its own. While a customer has an order's page
open, its checkout records the payment the moment it settles. For a customer
who closes the page first, run the module's reconcile pass every five minutes
from cron, as the web server's user:

```cron
*/5 * * * * www-data php /var/www/html/bin/console openreceive:reconcile
```

That line goes in `/etc/cron.d/`; in the web user's own crontab, leave out
`www-data`. On hosting with a control panel, add a cron job with the same
`php …/bin/console openreceive:reconcile` command. With Docker, the host's cron
runs `docker compose exec -T -u www-data prestashop php bin/console openreceive:reconcile`
from the Compose project's folder.

Each pass also finishes any order whose payment settled but which did not
move to "Payment accepted", and every checkout request runs one pass too.

## Check it

Make a Lightning invoice through the same route the order page uses, for a
new $5 test order, or for any order awaiting its OpenReceive payment by its id:

```sh
sudo -u www-data php bin/console openreceive:test-invoice --new
sudo -u www-data php bin/console openreceive:test-invoice <order id>
```

`--new` places an order for a hidden, downloadable test product, bought by a
test customer it creates once, `openreceive-test@example.invalid`, so no real
customer sees the order and its email reaches no one. `--amount=` changes
what it costs. PrestaShop keeps every order: cancel the test order under
**Orders** when you are done. Like any new order, it may reach the back
office's notifications.

It prints the amount in sats, the Lightning invoice and the order's
confirmation page, then each method the checkout offers: Bitcoin Lightning,
and each swap asset with its network and whether it is available for this
amount. A small order is often below a swap provider's minimum; that is the
amount, not a fault. The order's confirmation page carries the order's secret
key, so it opens the checkout in any browser.

## How a payment works

1. The customer picks the OpenReceive option at checkout and places the
   order. PrestaShop creates the order in "Awaiting Bitcoin payment" and opens
   its order confirmation page with the checkout on it.
2. The module charges the order's total with tax and shipping, in the order's
   currency, converted to sats at the current BTC price. Only the customer the
   order belongs to, signed in, or a browser PrestaShop already showed the
   order to (its confirmation page, which needs the order's secret key, or
   guest order tracking) may make or follow its payment, and only from a page
   with the order's checkout, whose token comes back with each request.
3. Once the wallet reports the payment, the module records an order payment
   for it, with the payment hash as its transaction id, in the same database
   transaction that settles it. Right after, the order moves to "Payment
   accepted": PrestaShop makes the invoice, emails the customer and runs its
   other modules' hooks. Should that step fail, the next pass finishes it.
4. The page loads again and says the payment was received.

A customer who leaves can come back from **Order history** in their account,
or a guest from **Guest order tracking**: the order's page shows the
checkout again while the order awaits its payment, with the same Lightning
invoice while it is still valid.

An unpaid order stays in "Awaiting Bitcoin payment" until you cancel it, as
with any other payment that never came. If you cancel an order and its
payment arrives afterwards, the module records the payment on the order,
leaves the order cancelled, and logs a warning.

Every line the module logs goes to PrestaShop's `var/logs/openreceive.log`.
Warnings and errors also appear under **Advanced Parameters → Logs** in the
back office.

## Refunds and removal

The receive-only wallet cannot send refunds. Send a refund from your own
wallet, then record it in PrestaShop. A customer whose swap deposit never
converted reclaims it from the same order's page, while the order still
awaits its payment. If you turn on swaps, you commit to keeping that path
available. See [swap refunds](swap-refunds.md).

Disabling the module hides the payment option and its checkout. Uninstalling
it also forgets both codes. It keeps the two tables, which are a record of
payments received, and the "Awaiting Bitcoin payment" order state, which
orders refer to.

## Tested, and not tested

Tested on 2026-10-19 with PrestaShop 9.2.0's official Docker image with GMP
added (PHP 8.5), its Hummingbird theme, MariaDB 11.8, a test wallet and a
test swap provider: the module uploaded through **Upload a module** in the
back office, and installed from the unzipped ZIP with `bin/console
prestashop:module install`; the swap code saved on the Configure page and
both codes from stdin; the doctor; `test-invoice --new`; and in Chromium, a
signed-in customer checking out with OpenReceive and paying on the order
confirmation page by Lightning and by USDT on Solana, after which each order
reads "Payment accepted" with its invoice. Coming back to the order through
**Order history** resumed the same Lightning invoice. Another customer, with
an order of their own, and a visitor were refused. A payment that settled
with no page open was recorded by `openreceive:reconcile`. Uninstalling kept
the payment records and the order state and forgot the codes.

Not tested: PrestaShop 9.0 and 9.1, the Classic theme, nginx with PHP-FPM,
shared hosting, multistore, friendly URLs turned off, guest checkout and guest
order tracking, carts PrestaShop splits into several orders, and updating
from an older release of the module.

## Next

- [Swap refunds](swap-refunds.md)
- [How OpenReceive stores payments](storage.md)
- [Payment safety](payment-safety-upgrade.md)
- [PrestaShop via BTCPay Server](prestashop.md)
