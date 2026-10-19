# OpenReceive agent directions (PrestaShop)

Install and configure the OpenReceive payment module in the PrestaShop store
you are working in. Preserve its theme, customers, products, orders and
prices. The module is a ZIP that bundles the PHP engine and the checkout's
script: do not install Composer or npm packages into PrestaShop, and do not
clone the OpenReceive repository.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets
customers pay with USDT, USDC, ETH or SOL instead; the provider converts the
payment to BTC over Lightning in the merchant's connected wallet. Available
assets and networks depend on the provider.

Run every `php` command below in PrestaShop's folder (the one that holds
`bin/console`), as the web server's user, never as root: a root run can leave
files in PrestaShop's `var/cache` that the web server cannot write. With
PrestaShop's official Docker image, that is
`docker compose exec -T -u www-data prestashop php bin/console …` (`-T` passes
stdin through; use the PrestaShop service's own name; the container starts in
`/var/www/html`). On a server, it is `sudo -u www-data php bin/console …` with
the site's own user.

## Step 0 — ask for the two codes, one question at a time

Before anything else, check one thing: whether OpenReceive is already
installed (`php bin/console openreceive:doctor`). If the command exists, it
prints `NWC_URI: set` or `unset` (likewise `LSC_URI_PRIMARY`), never the
values. A code that is already set is not asked for again; if both are set,
skip to Step 3.

Otherwise your next action is a question to the user. Do not download the
module, edit Docker files or search anywhere else before asking it. Do not
read PrestaShop's `app/config/parameters.php`, deploy config, container
environments or other projects looking for a code: a new install has neither
code yet.

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

The module needs PrestaShop 9 on 64-bit PHP 8.2+ with GMP and sodium. Check
first: `php -m` must list both `gmp` and `sodium`. PrestaShop's official
Docker image has sodium but not GMP, so with it, build an image that adds GMP:

1. Put a `Dockerfile` next to the Compose file, with the same tag as the
   PrestaShop service's `image:` line:

   ```dockerfile
   FROM prestashop/prestashop:<tag>
   RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev \
    && docker-php-ext-install gmp && rm -rf /var/lib/apt/lists/*
   ```

2. In the Compose file, replace that service's `image:` line with `build: .`
   (the folder that holds the Dockerfile). Change nothing else in the file.
3. Run `docker compose up -d --build`. PrestaShop's files and configuration
   stay in the service's volume; only PHP changes. Check `php -m` again.

On a server without GMP, say which PHP extension is missing and stop:
installing PHP extensions on the user's server is theirs to decide. On
PrestaShop 8, whose PHP stops at 8.1, say the module needs PrestaShop 9 and
stop.

The module is the ZIP attached to this GitHub release, one `openreceive`
folder. Unzip it into PrestaShop's `modules` folder; it changes no PrestaShop
file. Never install the GitHub source-code ZIP or a ZIP from an older release.
With the Docker image, download and unpack it inside the container, as the
web user, then install the module with PrestaShop's own console:

```sh
docker compose exec -T -u www-data prestashop sh -c 'curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v{{release}}/openreceive-prestashop-{{release}}.zip && unzip -oq openreceive-prestashop-{{release}}.zip -d modules && rm openreceive-prestashop-{{release}}.zip'
docker compose exec -T -u www-data prestashop php bin/console prestashop:module install openreceive
```

On a server, unpack it into `modules` the same way, make `modules/openreceive`
the web user's, and run the same `prestashop:module install openreceive`.
Installing creates the module's two tables in PrestaShop's database and its
order state, "Awaiting Bitcoin payment", adds the payment option to checkout
and makes the `openreceive:*` console commands appear. The option stays
hidden until a wallet code is saved.

## Step 2 — store the codes

Store each code yourself, one per command, and never as a shell argument:

1. Write the code with your file-editing tool, not a shell command (no
   `echo`, `printf` or heredoc), to a new file outside the PrestaShop
   folder, such as `/tmp/openreceive-code`.
2. Run `php bin/console openreceive:configure --nwc-uri=- < /tmp/openreceive-code`.
   In Docker: `docker compose exec -T -u www-data prestashop php bin/console openreceive:configure --nwc-uri=- < /tmp/openreceive-code`.
   For the LSC code, use `--lsc-uri-primary=-`.
3. Delete the file (`rm /tmp/openreceive-code`), whether the command passed
   or not.

The command asks the wallet first and saves the code, encrypted with the
shop's own key, only when the wallet answers as receive-only; a failure saves
nothing. If it reports spend methods such as `pay_invoice`, ask the user for a
receive-only code again. Saving the wallet code turns the payment option on;
saving the swap code renames it to "Bitcoin & stablecoins". Never write a code
into PrestaShop's database, `app/config/parameters.php` or any file in the
PrestaShop folder yourself.

Then run `php bin/console openreceive:doctor`. It names any failed check and
exits nonzero; fix it before going on.

## Step 3 — mint a test invoice, then stop

Place a small test order for a hidden test product, bought by a test
customer the command creates once (`openreceive-test@example.invalid`, so no
real customer sees it and no email reaches anyone), and mint its Lightning
invoice:

```sh
php bin/console openreceive:test-invoice --new
```

To use an order that already awaits its OpenReceive payment, pass its id
instead of `--new`. `test-invoice` goes through the same route as the order's
confirmation page. It prints the amount in sats, the BOLT11 invoice, the
order's confirmation page and the methods the checkout offers, each swap asset
marked available or followed by the reason it is not. That reason is the
answer; report it. "Below the provider minimum" or "above the provider
maximum" is about this order's amount, not a fault. Only when the reason says
the provider is unreachable does doctor's "Swap provider" line have more
detail. `test-invoice` and `doctor` are the whole check.

Give the user the order's confirmation page, which opens the checkout on this
same invoice in any browser. Tell them to cancel the test order under
**Orders** when they are done: PrestaShop keeps every order.

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark the order paid, and do not look for a way to (a wallet control port, a
test endpoint, another wallet). If the user wants a real settlement test, they
pay from the order's page with their own wallet; afterwards the order reads
"Payment accepted".

Setup ends here. Once doctor is clean and the user has the link, your last
message starts "Setup is finished" and has at most six short lines: the
order's page, the methods the checkout offers (Bitcoin, plus USDT, USDC, ETH
and SOL when the swap code is saved), the cron line below, and one line of
what to look at. Do not list each coin's availability, mention a minimum, or
say a coin will not work: a provider minimum depends on the order total, and
real orders will differ. Do not list what you changed or what doctor checked.
Send nothing after it.

PrestaShop has no scheduler, so the module's pass for customers who leave the
page before their payment settles needs one cron line, every five minutes:
`php bin/console openreceive:reconcile` as the web user. Give the user that
line in your last message; do not add it yourself, and do not add containers,
services or workers.

## Non-negotiables

- Never print, log or commit a code, never put one in a shell argument, and
  never write one into source files, `app/config/parameters.php`, the
  database or browser code. Doctor's set/unset is all you report.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this PrestaShop. Never read or run anything from another
  project or directory on this machine (its `node_modules`, tools or source),
  for any reason. A browser, Playwright, hand-made calls to the checkout's
  routes, database queries and reading the module's source are not part of
  setup: when doctor or `test-invoice` fails, report its output.
- Run `php` as the web server's user, never as root.
- Receive-only NWC is required. Never get past the preflight with a code that
  can spend.
- The module owns only its two payment tables in PrestaShop's database.
  PrestaShop owns customers, orders, prices, carriers and email. Do not add an
  external payment database or custom fulfillment code, and do not edit
  PrestaShop's own files or theme. The Dockerfile that adds GMP and the one
  Compose line that builds it are the only deployment change.
- IF SWAPS ARE ON, KEEP THE ROUTE BACK. A deposit that arrives short or late
  becomes refundable, and the customer claims it later from the same order's
  page. Keep the module installed while swap payments may still need a
  refund. https://openreceive.org/guides/swap-refunds.md
- A receive-only wallet cannot send refunds. Refund a settled payment manually
  from the wallet.

## Further reading

- [PrestaShop Quickstart](https://openreceive.org/guides/quickstart-prestashop.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)
