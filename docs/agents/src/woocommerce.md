# OpenReceive agent directions (WordPress + WooCommerce)

Install and configure the OpenReceive gateway in the existing WooCommerce
store. Preserve its theme, checkout, customer accounts, order model and prices.
The plugin bundles the PHP engine and checkout assets; the merchant does not
install npm or Composer packages on the WordPress server.

## Step 0 — inspect configuration

Check WordPress, WooCommerce and PHP versions, GMP and sodium availability,
whether the plugin is installed, and whether the Doctor panel reports the
receive-only NWC credential as set. Never display its value. For a real store,
ask the merchant to configure a receive-only wallet if none is available.
For repository development, use the Docker demo's explicit testkit override.

Upload a built plugin archive, not a zip of the source directory. The plugin
has not yet been accepted into the WordPress.org directory. Configuration and
the complete quickstart follow below.

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

- [Express Quickstart (Node)](https://openreceive.org/guides/quickstart-node.md)
- [Fastify Quickstart](https://openreceive.org/guides/quickstart-fastify.md)
- [FastAPI Quickstart](https://openreceive.org/guides/quickstart-fastapi.md)
- [Django Quickstart](https://openreceive.org/guides/quickstart-django.md)
- [Next.js Quickstart](https://openreceive.org/guides/quickstart-next.md)
- [Rails Quickstart](https://openreceive.org/guides/quickstart-rails.md)
- [PHP Quickstart (plain PHP)](https://openreceive.org/guides/quickstart-php.md)
- [Laravel Quickstart](https://openreceive.org/guides/quickstart-laravel.md)
- [BTCPay Server Quickstart](https://openreceive.org/guides/quickstart-btcpay.md)
- [BTCPay Plugin Reference](https://openreceive.org/guides/btcpay-reference.md)
- [Node ORM Recipes](https://openreceive.org/guides/node-orms.md)
- [Authorization](https://openreceive.org/guides/authorization.md)
- [Rate Limiting](https://openreceive.org/guides/rate-limiting.md)
- [Frontend Checkout](https://openreceive.org/guides/frontend-checkout.md)
- [Checkout UX](https://openreceive.org/guides/checkout-ux.md)
- [Headless Checkout](https://openreceive.org/guides/headless-checkout.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Environment Variables](https://openreceive.org/guides/environment-variables.md)
- [Payment Storage](https://openreceive.org/guides/storage.md)
- [Deploying OpenReceive](https://openreceive.org/guides/deploying.md)
- [Testing Your OpenReceive Integration](https://openreceive.org/guides/host-testing.md)
- [API Reference](https://openreceive.org/guides/api-reference.md)
- [Security](https://openreceive.org/guides/security.md)
- [Provider Registry](https://openreceive.org/guides/provider-registry.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)
- [React Material UI Recipe](https://openreceive.org/guides/react-material-ui-recipe.md)
- [Flask Recipe](https://openreceive.org/guides/flask-recipe.md)
- [Writing Your Own Checkout Route](https://openreceive.org/guides/custom-checkout-route.md)
- [Agent Directions: Node.js](https://openreceive.org/guides/agent-directions-node.md)
- [Agent Directions: Fastify](https://openreceive.org/guides/agent-directions-fastify.md)
- [Agent Directions: FastAPI](https://openreceive.org/guides/agent-directions-fastapi.md)
- [Agent Directions: Django](https://openreceive.org/guides/agent-directions-django.md)
- [Agent Directions: Next.js](https://openreceive.org/guides/agent-directions-next.md)
- [Agent Directions: Rails](https://openreceive.org/guides/agent-directions-rails.md)
- [Agent Directions: PHP](https://openreceive.org/guides/agent-directions-php.md)
- [Agent Directions: Laravel](https://openreceive.org/guides/agent-directions-laravel.md)
- [Agent Directions: BTCPay Server](https://openreceive.org/guides/agent-directions-btcpay.md)
- [WordPress + WooCommerce Quickstart](https://openreceive.org/guides/quickstart-woocommerce.md)
