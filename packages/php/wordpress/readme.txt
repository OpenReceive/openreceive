=== OpenReceive ===
Contributors: openreceive
Tags: bitcoin, lightning, woocommerce, payment gateway, stablecoin
Requires at least: 6.6
Tested up to: 7.1
Requires PHP: 8.2
Requires Plugins: woocommerce
Stable tag: 0.4.23
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Accept Bitcoin Lightning payments in WooCommerce, paid straight into your own wallet. Optional USDT, USDC, SOL and ETH swaps settle as BTC.

== Description ==
OpenReceive adds a Bitcoin Lightning payment method to WooCommerce. Customers pay a Lightning invoice, and the payment lands directly in a wallet you control. There is no OpenReceive account, no sign-up, and no processor in the middle.

The plugin connects to your wallet with a receive-only Nostr Wallet Connect (NWC) code. That code can create invoices and read incoming payments; it cannot spend. The plugin refuses to save a code that can send payments unless you explicitly override that check.

Optional swaps let customers pay with USDT, USDC, SOL, and ETH through your configured provider. You receive BTC over Lightning in your connected wallet. Available assets and networks depend on the provider; Lightning checkout works without swaps.

= What it does =
* Adds an OpenReceive payment method to classic checkout and checkout blocks. Both send the customer to the order-pay page, where the checkout shows a QR code and a wallet link.
* Prices the order from WooCommerce's own total, converted to sats at the current BTC rate.
* Marks the order paid through WooCommerce's normal `payment_complete`, so stock, order emails and status work as usual.
* Stores payment attempts in two tables in your existing WordPress database. It needs no separate database, service or daemon.
* Records each settlement exactly once, and finishes interrupted order completions on the next request or scheduled run.
* Supports High-Performance Order Storage (HPOS).
* Ships all checkout JavaScript, CSS and images inside the plugin. Nothing loads from a CDN.

= What you need =
* A Lightning wallet that issues a receive-only NWC code. See https://openreceive.org/get_a_nwc_code_to_receive_payments for wallets that do, or run your own, such as Alby Hub.
* 64-bit PHP 8.2 or newer with the GMP and sodium extensions. Many hosts do not enable GMP by default; https://openreceive.org/guides/wordpress-hosting explains how to check and enable it.
* MySQL 8 or MariaDB 10.5+. WordPress on SQLite is not supported.
* WooCommerce 9 or newer.

Documentation: https://openreceive.org/guides/quickstart-woocommerce

== Installation ==
1. Install and activate WooCommerce.
2. In Plugins > Add New, search for OpenReceive, then install and activate it. To install a release archive instead, use Plugins > Add New > Upload Plugin.
3. Open WooCommerce > Settings > Payments > OpenReceive.
4. Paste your receive-only NWC code and save. The plugin checks that the wallet can receive before it saves.
5. Optional: paste a Lightning Swap Connect code from your swap provider to accept USDT, USDC, SOL and ETH.
6. Enable the payment method.

Credentials are encrypted with keys derived from your WordPress authentication keys. You can set them as constants in wp-config.php instead (OPENRECEIVE_NWC_URI, OPENRECEIVE_LSC_URI_PRIMARY, OPENRECEIVE_LSC_URI_BACKUP); constants take precedence.

With WP-CLI, run `wp openreceive doctor` to check the setup, and `wp openreceive configure --nwc-uri=-` to set a code from stdin.

== Frequently Asked Questions ==
= Does OpenReceive charge a fee? =
No. OpenReceive is free software and takes no cut. Your wallet operator's Lightning fees and, for swaps, your swap provider's fees still apply.

= Can the plugin send refunds from my wallet? =
No. The wallet code is receive-only, so merchant refunds are manual: send them from your wallet. Payer swap refunds use the order-pay link and the configured swap provider.

= What happens when the customer closes the page? =
WooCommerce's Action Scheduler checks for payments every minute when WordPress runs scheduled work. On a low-traffic store, use a real cron runner, or run the optional `wp openreceive notifications` worker.

= The Plugins screen says "OpenReceive is not running" =
The plugin activates on any WordPress site, but it only runs with 64-bit PHP, the GMP and sodium extensions, and a MySQL or MariaDB database. The notice names what is missing. Until that is fixed, the plugin adds no payment method and makes no network requests. Most hosts can enable GMP and sodium in the control panel or on request. See https://openreceive.org/guides/wordpress-hosting .

= What happens after rotating WordPress authentication keys? =
Enter the encrypted payment credentials again. Values configured as constants are unaffected.

= Does uninstalling delete payment records? =
Deactivating keeps them. Deleting the plugin removes its two tables only if "Remove data on uninstall" is enabled. WooCommerce orders are always kept.

== External services ==
This plugin connects to the following services. It sends no telemetry.

Your Lightning wallet, over Nostr Wallet Connect. The plugin connects to the relay named in the NWC code you configure, to create an invoice when a customer checks out and to check for incoming payments. It sends invoice amounts and descriptions to your wallet through that relay. The relay and wallet are chosen and operated by you or your wallet provider; their terms and privacy policies apply.

BTC price feeds. To convert the order total to sats, the plugin requests current BTC prices in a fixed list of fiat currencies from CoinGecko, and from the OpenReceive price mirror if CoinGecko does not answer. The request contains only that fixed list of currency codes. No order or customer details are sent. CoinGecko terms: https://www.coingecko.com/en/terms ; privacy policy: https://www.coingecko.com/en/privacy . OpenReceive price mirror (openreceive.org) terms and privacy policy: https://openreceive.org/privacy .

Links shown at checkout. To help customers pay a Lightning invoice, the checkout lists wallets, exchanges and swap services, such as Boltz, Strike and Kraken, with links to their websites or help pages. For swap payments it links transactions and addresses to the public block explorers Etherscan, Solscan and Tronscan. These are ordinary links. The plugin and the checkout never contact these sites and send them no data; a site is visited only if the customer opens a link. All icons and images are bundled with the plugin.

Swap provider, only if you configure one. When a customer chooses USDT, USDC, SOL or ETH, the plugin sends the amount, the Lightning invoice to be paid, and the customer's refund address to the FixedFloat-compatible provider named in your swap connection code, and later checks the swap's status. Review that provider's terms and privacy policy before enabling swaps. FixedFloat terms: https://ff.io/terms-of-service ; privacy policy: https://ff.io/privacy-policy .

== Source code ==
The bundled checkout JavaScript and CSS are compiled. Their human-readable source is at https://github.com/OpenReceive/openreceive . To rebuild this plugin from source, run `npm ci`, `npm run build:packages`, `composer install --working-dir=packages/php/wordpress` and `npm run release:wordpress:build` in that repository. PHP dependencies are listed in composer.json and isolated with Strauss.

== Screenshots ==
1. The OpenReceive checkout on the WooCommerce order-pay page.

== Changelog ==
Release notes for every version: https://github.com/OpenReceive/openreceive/blob/master/CHANGELOG.md
