# OpenReceive guides

OpenReceive adds Bitcoin Lightning checkout to your application or store.
Payments go straight to your wallet, and payment attempts are stored in your
existing database. Pick your framework or platform below.

OpenReceive can also accept **USDT, USDC, SOL, and ETH** through a swap
provider you configure. The provider converts the payment to **BTC over
Lightning**, and it settles into the merchant's connected wallet. Swaps are
optional. The provider decides which assets and networks are available.

## Your own app

1. [Express quickstart (Node)](quickstart-node.md)
   - [Bitcoin checkout on Replit](replit.md): the same Express setup, built by Replit Agent and published on Replit
2. [Fastify quickstart](quickstart-fastify.md)
3. [Next.js quickstart](quickstart-next.md)
   - [Bitcoin checkout on Vercel and v0](vercel.md): the same Next.js setup, hosted on Vercel or built by v0
4. [NestJS quickstart](quickstart-nestjs.md): the Express adapter, mounted in `main.ts`
5. [Node ORM recipes](node-orms.md)
6. [Rails quickstart](quickstart-rails.md)
7. [FastAPI quickstart](quickstart-fastapi.md)
   - [Flask quickstart](quickstart-flask.md): the same Python engine, as a Flask Blueprint
8. [Django quickstart](quickstart-django.md)
9. [PHP quickstart (plain PHP)](quickstart-php.md)
10. [Laravel quickstart](quickstart-laravel.md)

Recipes: [React + Material UI](../recipes/react-material-ui.md),
[TanStack Start](../recipes/tanstack-start.md) (a server route, on Node or Cloudflare Workers),
[Supabase Edge Functions](../recipes/supabase-edge-functions.md).
On Node, the same handler mounts in [SvelteKit](../recipes/sveltekit.md),
[Nuxt](../recipes/nuxt.md), [Astro](../recipes/astro.md) and
[React Router](../recipes/react-router.md).

## AI app builders

- [Bitcoin checkout on Lovable](lovable.md)
- [Bitcoin checkout on Bolt](bolt.md)
- [Bitcoin checkout with Supabase](supabase.md): payment storage in Supabase Postgres, through its pooler, with Supabase Auth

## Stores and billing panels

- [WordPress + WooCommerce quickstart](quickstart-woocommerce.md)
- [Easy Digital Downloads quickstart](quickstart-edd.md): the same WordPress plugin
- [WordPress hosting requirements](wordpress-hosting.md): which hosts can run the WordPress plugin
- [Paymenter quickstart](quickstart-paymenter.md)
- [FOSSBilling quickstart](quickstart-fossbilling.md)
- [PrestaShop quickstart](quickstart-prestashop.md)
- [Odoo quickstart](quickstart-odoo.md)
- [Medusa quickstart](quickstart-medusa.md)
- [Vendure quickstart](quickstart-vendure.md)
- [BTCPay Server quickstart](quickstart-btcpay.md), plus its [reference](btcpay-reference.md)
- Through BTCPay Server: [Odoo](odoo.md), [Magento](magento.md) and [PrestaShop](prestashop.md)

## Checkout

- [Authorization and the host](authorization.md)
- [Frontend checkout](frontend-checkout.md)
- [Checkout UX](checkout-ux.md)
- [Headless checkout](headless-checkout.md)
- [Writing your own checkout route](custom-checkout-route.md)
- [Rate limiting](rate-limiting.md)

## Swaps

- [Automated swaps](automated-swaps.md)
- [Swap refunds, and the way back to them](swap-refunds.md)
- [Lightning Swap Connect (LSC) URI](lightning-swap-connect.md)
- [Provider registry](provider-registry.md)

## Running it

- [Environment variables](environment-variables.md)
- [Payment storage](storage.md)
- [Deploying OpenReceive](deploying.md)
  - [Bitcoin checkout on serverless hosts](serverless.md): Netlify, AWS Lambda, Google Cloud Run and AI Studio, and pooled database URLs
  - [Bitcoin checkout in mobile apps](mobile-apps.md): React Native, Flutter, Swift and Kotlin apps, and what the app stores allow
- [Payment safety upgrade and repair](payment-safety-upgrade.md): how to roll out an upgrade and how unpaid attempts close
- [Testing your OpenReceive integration](host-testing.md)
- [Security](security.md)
- [Price feeds](price-feeds.md)
- [How we test platforms](how-we-test-platforms.md): what a Tested badge on openreceive.org means

## Reference

- [API reference](api-reference.md)

## With a coding agent

Give your agent one of the agent-directions files instead of a reading list.
Each one holds the rules to follow before any code (Step 0) and the full
matching quickstart, and works pasted into an editor with no network access:
[Express](https://openreceive.org/agent-directions/node/full.md),
[Fastify](https://openreceive.org/agent-directions/fastify/full.md),
[Next.js](https://openreceive.org/agent-directions/next/full.md),
[NestJS](https://openreceive.org/agent-directions/nestjs/full.md),
[SvelteKit](https://openreceive.org/agent-directions/sveltekit/full.md),
[Nuxt](https://openreceive.org/agent-directions/nuxt/full.md),
[Astro](https://openreceive.org/agent-directions/astro/full.md),
[React Router](https://openreceive.org/agent-directions/react-router/full.md),
[TanStack Start](https://openreceive.org/agent-directions/tanstack-start/full.md),
[FastAPI](https://openreceive.org/agent-directions/fastapi/full.md),
[Django](https://openreceive.org/agent-directions/django/full.md),
[Flask](https://openreceive.org/agent-directions/flask/full.md),
[Rails](https://openreceive.org/agent-directions/rails/full.md),
[PHP](https://openreceive.org/agent-directions/php/full.md),
[Laravel](https://openreceive.org/agent-directions/laravel/full.md),
[Lovable](https://openreceive.org/agent-directions/lovable/full.md),
[Bolt](https://openreceive.org/agent-directions/bolt/full.md),
[WooCommerce](https://openreceive.org/agent-directions/woocommerce/full.md),
[Easy Digital Downloads](https://openreceive.org/agent-directions/edd/full.md),
[Paymenter](https://openreceive.org/agent-directions/paymenter/full.md),
[FOSSBilling](https://openreceive.org/agent-directions/fossbilling/full.md),
[PrestaShop](https://openreceive.org/agent-directions/prestashop/full.md),
[Odoo](https://openreceive.org/agent-directions/odoo/full.md),
[Medusa](https://openreceive.org/agent-directions/medusa/full.md),
[Vendure](https://openreceive.org/agent-directions/vendure/full.md),
[BTCPay Server](https://openreceive.org/agent-directions/btcpay/full.md) or
[a mobile app's server](https://openreceive.org/agent-directions/mobile/full.md).
To hand an agent a link instead, drop `/full` from the URL: that short page
tells it to download the full file with its shell.
