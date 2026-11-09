# Changelog

## 0.4.33 - 2026-11-09

- No changes to the plugin's own code. It picks up the engine fixes of 0.4.33:
  a checkout reopened for a paid order opens on its receipt, a relay handshake
  slower than 3 s no longer fails the checkout, and a relay that stops answering
  reaches the buyer as a retryable 503.

## 0.4.32 - 2026-11-07

- Added: this changelog now ships in the npm package, for Vendure's plugin
  directory, and the plugin class carries the `@category Plugin` tag the
  directory builds its docs from.
- Fixed: a wallet that was down when the plugin started no longer leaves a
  relay connection open on each retry. The wallet check now closes the client
  it built when it fails.
- Fixed (checkout): a failed Bitcoin invoice shows a Try again button, a
  wallet that did not answer shows the payer one plain sentence, and the swap
  breakdown's first row reads "Total" with the order's own amount.

## 0.4.31 - 2026-10-20

- Changed: new npm keywords, metadata only: `stablecoin`, `usdt`, `usdc`,
  `payment-gateway`, `self-hosted` and `bitcoin-payments`. USDT and USDC
  still arrive only through a configured swap provider, as BTC over
  Lightning in the merchant's wallet.

## 0.4.30 - 2026-10-19

- Added: `@openreceive/vendure`, a plugin and payment method
  handler for Vendure 3.3+ (Node 22.12+, PostgreSQL, MySQL or MariaDB). Add
  `OpenReceivePlugin` from `@openreceive/vendure/plugin` to vendure-config.
  The buyer pays at the storefront's checkout before the order is placed:
  `POST /openreceive/order`, with the buyer's Vendure session, moves the
  active order to ArrangingPayment and answers its reference, the order's
  code, currency and amount due, so a changed cart gets a new invoice. Only
  that session, or the signed-in customer who owns the order, may pay it.
  Once the payment settles, the plugin adds a settled Vendure payment (the
  payment hash as transaction id) under a lock on the order, and Vendure
  places it; the Shop API's `addPaymentToOrder` cannot add one. A scheduled
  task on the worker, every minute, places orders whose buyer left. The
  plugin keeps its attempts in Vendure's database over Vendure's own
  connection, and a migration creates the two tables when the server runs
  its migrations. `dist/enable-openreceive.js` creates the payment method
  through the Admin API. A refund made in the dashboard stays pending. Docs:
  the Vendure quickstart with the code for Vendure's Next.js starter, and
  agent directions (/agent-directions/vendure.md, `references/vendure.md`
  in the skill). A trial platform (trials/platforms/vendure) runs Vendure
  3.8, its worker and the Next.js starter, and a CI lane runs the plugin
  against a real Vendure server on PostgreSQL.
