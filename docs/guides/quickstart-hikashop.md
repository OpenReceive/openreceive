# HikaShop quickstart

[HikaShop](https://www.hikashop.com) is an e-commerce extension for Joomla.
The OpenReceive package adds a payment method to it: the customer pays with
Bitcoin over Lightning, straight into your own wallet, on HikaShop's own
thank-you page. With a swap provider, the same page also takes USDT, USDC,
SOL and ETH, which the provider converts to BTC over Lightning into the same
wallet. The free HikaShop Starter edition is enough.

HikaShop keeps owning customers, orders, prices and shipping. The package
keeps its payment attempts in two tables of Joomla's own database. When a
payment settles, it records it the way HikaShop's payment plugins do: a
payment entry in the order's history, with the payment hash as its payment
id, in the same database transaction that settles the payment. The order then
moves to "Confirmed", so HikaShop gives it its invoice number, emails the
customer and runs its other plugins as it does for any other payment.

Requirements: Joomla 5 or 6 with HikaShop 6, on 64-bit PHP 8.2 or later with
GMP and sodium, and Joomla's MySQL or MariaDB database. The official Joomla
Docker images already have GMP and sodium. A cron job runs the package's
reconcile pass, as [below](#the-cron-job).

The package is licensed GPL-2.0-or-later, as the Joomla Extensions Directory
requires. The OpenReceive engine it bundles keeps its MIT license.

## Install the package

Each GitHub release attaches the package as `openreceive-hikashop-<version>.zip`.
In Joomla's administrator, open **System → Install → Extensions** and drop the
ZIP in. It installs two plugins and enables both: **HikaShop Payment -
OpenReceive**, the payment method, and **Console - OpenReceive**, its commands
for Joomla's console.

From a shell, install it with Joomla's own console instead, in the site's
folder (the one that holds `cli/joomla.php`):

```sh
cd /var/www/html
curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.6.2/openreceive-hikashop-0.6.2.zip
sudo -u www-data php cli/joomla.php extension:install --path="$PWD/openreceive-hikashop-0.6.2.zip"
rm openreceive-hikashop-0.6.2.zip
```

Use your own site folder and web server user. Installing creates the
package's two tables. The payment method stays hidden at checkout until a
wallet code is saved.

The ZIP already bundles the plugin's dependencies and the checkout's script,
under their own prefixed names, so Composer never runs and nothing in
Joomla's own `libraries/vendor` changes. The GitHub source-code ZIP is not an
installable package.

### Joomla in Docker

Run every command inside the container, in `/var/www/html`, as its web user
`www-data`. Download the release there too:

```sh
docker compose exec -T -u www-data joomla sh -c 'cd /tmp && curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.6.2/openreceive-hikashop-0.6.2.zip'
docker compose exec -T -u www-data joomla php cli/joomla.php extension:install --path=/tmp/openreceive-hikashop-0.6.2.zip
```

Use your Joomla service's own name. Always pass `-u www-data`: a command that
runs as root can leave files in Joomla's cache that the web server cannot
write.

### Updates

The package registers its update server, so Joomla offers each new release in
**System → Update → Extensions** like any other extension. Updating keeps the
saved wallet codes and the payment rows.

## Configure the wallet

You need a receive-only NWC code: a Nostr Wallet Connect code that can create
invoices and read payments but cannot spend. The plugin refuses a code that
can spend.

In HikaShop, open **System → Payment methods**, click **New** and pick
**OpenReceive**. Paste the code into **Receive-only NWC code**, publish the
method and save. To accept stablecoins too, paste a swap provider code into
**Swap provider code (optional)**. The plugin keeps both in HikaShop's
configuration table, sealed with a key derived from the site's own secret in
`configuration.php`, and the page never shows them again; it says only
whether each is set. Every OpenReceive payment method uses the same codes.

From a terminal, pipe each code into `openreceive:configure` from your secret
manager or a protected file. Never type a code as a command argument:

```sh
sudo -u www-data php cli/joomla.php openreceive:configure --nwc-uri=- < /secure/path/wallet-code
sudo -u www-data php cli/joomla.php openreceive:configure --lsc-uri-primary=- < /secure/path/swap-code
sudo -u www-data php cli/joomla.php openreceive:doctor
```

The settings page and `configure` both ask the wallet first and save the code
only when it answers as a receive-only wallet. `configure` also makes the
payment method, "Bitcoin Lightning", or "Bitcoin & stablecoins" once a swap
code is saved, when the shop has none yet; `--name="…"` sets your own. Skip
the swap code for Bitcoin-only checkout. The payment method's own page sets
everything else HikaShop offers for a payment method: its name, description,
zones, currencies and the status a paid order moves to ("Confirmed" unless
you pick another).

`doctor` checks HikaShop, the plugin, PHP and its GMP and sodium, each code
as set or unset (never its value), the payment method, the tables, the
checkout's files, the wallet, the price feed for every currency the shop
sells in, each swap provider, when the wallet was last scanned and when the
cron line last ran. It exits nonzero when a check fails.

## The cron job

Joomla and HikaShop run nothing between page views. While a customer has an
order's page open, its checkout records the payment the moment it settles.
For a customer who closes the page first, run the package's reconcile pass
every five minutes from cron, as the web server's user:

```cron
*/5 * * * * www-data php /var/www/html/cli/joomla.php openreceive:reconcile
```

That line goes in `/etc/cron.d/`; in the web user's own crontab, leave out
`www-data`. On hosting with a control panel, add a cron job with the same
`php …/cli/joomla.php openreceive:reconcile` command. With Docker, add this
to the host's crontab, with your Compose project's folder:

```cron
*/5 * * * * cd /path/to/shop && docker compose exec -T -u www-data joomla php cli/joomla.php openreceive:reconcile
```

Each pass also finishes any order whose payment settled but which did not
move to "Confirmed", and every checkout request runs one pass too.

Until the cron line has run in the last 15 minutes, the payment method's page
in HikaShop shows a warning with the line to add, and `doctor` shows when it
last ran.

## Check it

Make a Lightning invoice through the same route the thank-you page uses, for
a new $5 test order, or for any unpaid OpenReceive order by its id:

```sh
sudo -u www-data php cli/joomla.php openreceive:test-invoice --new
sudo -u www-data php cli/joomla.php openreceive:test-invoice <order id>
```

`--new` places an order with one line, "OpenReceive test payment", and no
product, so no stock moves. A test customer it creates once,
`openreceive-test@example.invalid`, has no Joomla account, so nobody can sign
in as it and its email reaches no one. `--amount=` changes what it costs.
HikaShop keeps every order: cancel the test order under **Orders** when you
are done.

It prints the amount in sats, the Lightning invoice and the order's
thank-you page, then each method the checkout offers: Bitcoin Lightning, and
each swap asset with its network and whether it is available for this
amount. A small order is often below a swap provider's minimum; that is the
amount, not a fault. The thank-you page's address carries the order's token,
so it opens the checkout in any browser. Pass `--live-site=https://your.shop`
when Joomla's `configuration.php` has no `$live_site`, so the printed link
names your shop.

## How a payment works

1. The customer picks the OpenReceive method at checkout and presses
   **Finish**. HikaShop creates the order, unpaid in its "Created" status,
   and opens its thank-you page with the checkout on it.
2. The customer taps the payment method on that page. The plugin charges the
   order's total with tax and shipping, in the order's currency, converted to
   sats at the current BTC price. Only the customer the order belongs to,
   signed in, or a browser HikaShop already showed the order's page to (the
   thank-you page, which needs the customer's session or the order's token)
   may make or follow its payment, and only from a page with the order's
   checkout, whose Joomla form token comes back with each request.
3. Once the wallet reports the payment, the plugin writes it in the order's
   history, with the payment hash as its payment id, in the same database
   transaction that settles it. Right after, the order moves to "Confirmed"
   through HikaShop's own order class: the invoice number, the emails and the
   other plugins' hooks are HikaShop's. Should that step fail, the next pass
   finishes it.
4. The page loads again and shows the order paid.

A signed-in customer who leaves can come back from **Orders** in their
account: the order's page shows the checkout again while the order is
unpaid, and resumes the same Lightning invoice while it is still valid.

An unpaid order stays in "Created" until you cancel it, as with any other
payment that never came. If you cancel an order and its payment arrives
afterwards, the plugin writes the payment in the order's history, leaves the
order cancelled, and logs a warning.

Every line the plugin logs goes to Joomla's log folder, in
`administrator/logs/openreceive.php`. Warnings and errors also appear in
HikaShop's log in its back office.

## Refunds and removal

The receive-only wallet cannot send refunds. Send a refund from your own
wallet, then record it in HikaShop. A customer whose swap deposit never
converted reclaims it from the same order's page, while the order is still
unpaid. If you turn on swaps, you commit to keeping that path available. See
[swap refunds](swap-refunds.md).

Unpublishing the payment method hides it at checkout; disabling the plugin
also hides the checkout on order pages. Uninstalling the package forgets both
codes. It keeps the two tables, which are a record of payments received, and
the payment entries in each order's history.

## Tested, and not tested

Tested on 2026-11-26 with HikaShop Starter 6.8.2 on Joomla 6.2.0 (PHP 8.4)
and on Joomla 5.4.10 (PHP 8.3), their official Docker images, MariaDB 11.8,
the Cassiopeia template and a test wallet: the package installed with
`extension:install`; a spend-capable code refused and the receive-only code
saved from stdin; the doctor; the code saved, a bad code and a spend-capable
code refused, on the payment method's page in HikaShop's back office;
`test-invoice --new`; and in Chromium, a signed-in customer checking out with
OpenReceive and paying on the thank-you page by Lightning, after which the
order read "Confirmed" with its payment in the order's history. The unpaid
order's page in the customer's account showed the same checkout. A visitor
without the order's session or token was refused. A payment that settled with
no page open was recorded by `openreceive:reconcile`, once. Uninstalling
kept the payment records and forgot the codes, and the package installed
again.

Not tested: swaps through a swap provider, guest checkout, HikaShop Essential
and Business, the "pay later" button of those editions, multilingual sites,
nginx with PHP-FPM, shared hosting, Joomla's `pdomysql` database driver on a
live site (its settlement path has unit tests), and updating from an older
release of the package.

## Next

- [Swap refunds](swap-refunds.md)
- [How OpenReceive stores payments](storage.md)
- [Payment safety](payment-safety-upgrade.md)
