# OpenReceive agent directions (WordPress + WooCommerce)

Install and configure the OpenReceive gateway in the existing WooCommerce
store. Preserve its theme, checkout, customer accounts, order model and prices.
The plugin bundles the PHP engine and checkout assets; the merchant does not
install npm or Composer packages on the WordPress server.

## Step 0 — collect and save the codes, one at a time

Inspect WordPress, WooCommerce and PHP versions and GMP/sodium in both the web
and WP-CLI runtimes. If installed, use `wp openreceive doctor` to see which
credentials are set, without displaying their values. Skip codes already set.
Do not search other projects, container environments or deployment secrets.

Ask for the missing receive-only NWC code first, with this walkthrough:

> In Rizful, open the menu → NWC → Receive-only NWC code → Copy
> (https://openreceive.org/get_a_nwc_code_to_receive_payments). Alby Hub also
> works: Connections → Add Connection → Read Only. Paste the code here and
> I will save it for you.

Install the exact built plugin archive described below if needed. When the code
arrives, save it yourself with `wp openreceive configure --nwc-uri=-`, supplying
the code through the process's stdin. Never put it in shell arguments, shell
history, logs, source files or browser code. Do not ask the user to edit PHP or
an environment file. The command encrypts the code and runs wallet preflight
before saving; a failure preserves existing settings. Constants in wp-config.php
remain authoritative; if a constant must change, use the host's secret workflow.

Next ask whether customers should also pay with USDT, USDC, SOL and ETH, unless
the user already requested these. A configured swap provider converts payments
to BTC over Lightning in the merchant's connected wallet; available assets and
networks depend on the provider. Ask for the LSC code separately:

> Go to https://lightning-swap.com, sign in for API keys, create a key, and copy
> the whole URI (https://openreceive.org/set_up_swap_provider). Paste it here
> and I will save it, or say “Bitcoin only”.

Save it with `wp openreceive configure --lsc-uri-primary=-` through stdin.
Mention FixedFloat only if the merchant already uses it. Save an optional backup
separately with `--lsc-uri-backup=-`. Do not use generic `wp wc payment_gateway`
or REST settings writes for credentials: they are deliberately rejected.

Run `wp openreceive configure --enable`, then `wp openreceive doctor`. Resolve
failed checks before checkout testing. Create an unpaid test order and verify
that the order-pay page opens, lists the configured methods, and resumes its
Lightning invoice on reload. Ask the merchant to pay only if they want a real
settlement test.

The plugin owns only its payment-attempt tables in the WordPress database.
WooCommerce owns orders, totals, stock and email. Do not add an external
idempotency store, payment database, browser wallet credentials or custom
fulfillment implementation. Guest return links use WooCommerce's order key;
the plugin verifies it before issuing an expiring order-bound cookie.

Run `wp openreceive doctor` after configuration. Use the documented scheduled
reconciliation or optional notifications command for offline settlement.
Manual merchant refunds and provider-managed payer swap refunds are separate
flows; a receive-only NWC wallet cannot send payments.

## Further reading

- [WordPress + WooCommerce Quickstart](https://openreceive.org/guides/quickstart-woocommerce.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)
- [Payment Safety Upgrade](https://openreceive.org/guides/payment-safety-upgrade.md)
