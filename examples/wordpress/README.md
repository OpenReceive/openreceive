# WordPress + WooCommerce demo

Try Bitcoin Lightning checkout in a real WooCommerce shop. This example runs
WordPress, MySQL, and the built OpenReceive plugin with WooCommerce checkout
blocks. Follow an order through payment, wallet settlement, stock updates,
and fulfillment using WooCommerce's own order lifecycle.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

```sh
npm run demo wordpress
```

Set `NWC_URI` in the root `.env` first. Open <http://localhost:3009>.
The local admin is `demo` / `openreceive-local-demo` at `/wp-admin/`;
set `DEMO_ADMIN_PASSWORD` in the container environment to override the initial
password. These are local demo defaults. Configure the gateway in
**WooCommerce → Settings → Payments → OpenReceive**.

The image builds the plugin and its browser assets from this checkout.
The WordPress files and MySQL database persist in named Docker volumes.
All application servers and backing services run in Docker.

For an isolated fake-wallet shop (no credentials required):

```sh
docker compose -p openreceive-wp-test -f examples/wordpress/compose.yml -f examples/wordpress/compose.override.yml.example -f examples/wordpress/compose.testkit.yml up --build -d --wait
npm run test:wordpress
npm run test:e2e:wordpress
```

The testkit override disables the `.env` file. Its control routes exist only
with `OPENRECEIVE_DEMO_WALLET=testkit` defined server-side. `GET
/wp-json/openreceive/testkit/state` lists fake invoices; `POST
/wp-json/openreceive/testkit/settle` accepts `payment_hash` to simulate payment.
The fake wallet state has its own Docker volume, so invoice counters survive
container recreation alongside the database. This mode must only run on a
disposable local shop.

The checkout page can be switched to classic checkout by replacing its block
with `[woocommerce_checkout]` in the WordPress editor. The payment page and
settlement contract are identical for both checkout styles.

Stop and remove only this disposable test stack:

```sh
docker compose -p openreceive-wp-test -f examples/wordpress/compose.yml -f examples/wordpress/compose.testkit.yml down -v
```
