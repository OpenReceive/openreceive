=== OpenReceive – Bitcoin Lightning payments for WooCommerce ===
Contributors: openreceive
Tags: lightning, bitcoin, payments, woocommerce
Requires at least: 6.6
Tested up to: 7.1
Requires PHP: 8.2
Requires Plugins: woocommerce
Stable tag: 0.4.5
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Receive Bitcoin Lightning payments into your wallet, with optional USDT, USDC, SOL and ETH swaps through your provider.

== Description ==
Optional swaps let customers pay with USDT, USDC, SOL, and ETH through your configured provider. You receive BTC over Lightning in your connected wallet. Available assets and networks depend on the provider; Lightning checkout works without swaps.

WooCommerce owns orders, prices, stock and fulfillment. OpenReceive stores payment attempts in the existing WordPress database. It does not require an OpenReceive account, another database or a service daemon.

Supports classic checkout, checkout blocks and HPOS. Requires WooCommerce 9+, 64-bit PHP 8.2+, GMP and sodium, and MySQL 8 / MariaDB 10.5+.

== Installation ==
Upload the release zip in Plugins > Add New > Upload Plugin. Activate WooCommerce first, then OpenReceive. Configure a receive-only NWC code in WooCommerce > Settings > Payments > OpenReceive. Constants in wp-config.php take precedence over encrypted settings.

== External services ==
The plugin connects to the merchant's NWC wallet relay(s), supplied in their own connection code, to create invoices and read payments. The wallet operator's terms and privacy policy apply.

BTC/fiat price requests send currency codes to CoinGecko and the OpenReceive price mirror; no orders or customer details are sent. CoinGecko: https://www.coingecko.com/en/terms and https://www.coingecko.com/en/privacy . OpenReceive: https://openreceive.org . No telemetry is collected.

Optional LSC connections send amounts, invoice destinations and payer refund addresses to the merchant's chosen FixedFloat-compatible provider. Review that provider's terms and privacy policy before enabling swaps. FixedFloat: https://ff.io/terms-of-service and https://ff.io/privacy-policy .

All checkout JavaScript, CSS and images ship locally. Human-readable source: https://github.com/OpenReceive/openreceive . Build with npm ci, npm run build:packages, composer install in packages/php/wordpress, and npm run release:wordpress:build. Dependencies are isolated with Strauss.

== Frequently Asked Questions ==
= Can the plugin send refunds from my wallet? =
No. Merchant refunds are manual. Payer swap refunds use the order-pay link and the configured swap provider.
= What happens when the customer closes the page? =
WooCommerce's Action Scheduler runs reconciliation every minute when WordPress executes scheduled work. Use a real cron runner on low-traffic sites, or the optional wp openreceive notifications worker.
= What happens after rotating WordPress authentication keys? =
Re-enter encrypted payment credentials. Values configured as constants are unaffected.

== Changelog ==
= 0.4.4 =
Initial WooCommerce integration, Docker example and local plugin archive build.
