# OpenReceive guides

OpenReceive adds Bitcoin Lightning checkout to your application. Payments go
straight to your wallet, and payment attempts are stored in your existing
database. Pick a framework quickstart below. Then add the checkout UI and
connect your authorization, pricing, and fulfillment hooks.

OpenReceive can also accept **USDT, USDC, SOL, and ETH** through a swap
provider you configure. The provider converts the payment to **BTC over
Lightning**, and it settles into the merchant's connected wallet. Swaps are
optional. The provider decides which assets and networks are available.

1. [Express quickstart (Node)](quickstart-node.md)
   - [Bitcoin checkout on Replit](replit.md): the same Express setup, built by Replit Agent and published on Replit
2. [Fastify quickstart](quickstart-fastify.md)
3. [Next.js quickstart](quickstart-next.md)
   - [Bitcoin checkout on Vercel and v0](vercel.md): the same Next.js setup, hosted on Vercel or built by v0
4. [Node ORM recipes](node-orms.md)
5. [Rails quickstart](quickstart-rails.md)
6. [FastAPI quickstart](quickstart-fastapi.md)
7. [Django quickstart](quickstart-django.md)
8. [PHP quickstart (plain PHP)](quickstart-php.md)
9. [Laravel quickstart](quickstart-laravel.md)
10. [BTCPay Server quickstart](quickstart-btcpay.md), plus its [reference](btcpay-reference.md)
11. [Authorization and the host](authorization.md)
12. [Rate limiting](rate-limiting.md)
13. [Frontend checkout](frontend-checkout.md)
14. [Checkout UX](checkout-ux.md)
15. [Headless checkout](headless-checkout.md)
16. [Writing your own checkout route](custom-checkout-route.md)
17. [Automated swaps](automated-swaps.md)
18. [Swap refunds, and the way back to them](swap-refunds.md)
19. [Lightning Swap Connect (LSC) URI](lightning-swap-connect.md)
20. [Environment variables](environment-variables.md)
21. [Payment storage](storage.md)
   - [Bitcoin checkout with Supabase](supabase.md): payment storage in Supabase Postgres, through its pooler, with Supabase Auth
22. [Payment safety upgrade and repair](payment-safety-upgrade.md): how to roll out the upgrade and how to review and recover existing attempts.
23. [Deploying OpenReceive](deploying.md)
24. [Testing your OpenReceive integration](host-testing.md)
25. [API reference](api-reference.md)
26. [Security](security.md)
27. [Price feeds](price-feeds.md)
28. [Provider registry](provider-registry.md)
29. [WordPress + WooCommerce quickstart](quickstart-woocommerce.md)
30. [WordPress hosting requirements](wordpress-hosting.md): which hosts can run the WooCommerce plugin
31. [How we test platforms](how-we-test-platforms.md): what a Tested badge on openreceive.org means

Recipes: [React + Material UI](../recipes/react-material-ui.md),
[Flask](../recipes/flask.md) (the Python engine as a Blueprint),
[TanStack Start](../recipes/tanstack-start.md) (a server route, on Node or Cloudflare Workers)

Building this with a coding agent? Give it one of the agent-directions
payloads instead of a reading list:
[Node (Express)](https://openreceive.org/agent-directions/node/full.md),
[Fastify](https://openreceive.org/agent-directions/fastify/full.md),
[Next.js](https://openreceive.org/agent-directions/next/full.md),
[FastAPI](https://openreceive.org/agent-directions/fastapi/full.md),
[Django](https://openreceive.org/agent-directions/django/full.md),
[Rails](https://openreceive.org/agent-directions/rails/full.md),
[PHP](https://openreceive.org/agent-directions/php/full.md),
[Laravel](https://openreceive.org/agent-directions/laravel/full.md),
[WooCommerce](https://openreceive.org/agent-directions/woocommerce/full.md) or
[BTCPay Server](https://openreceive.org/agent-directions/btcpay/full.md).
These are the exact files the site's copy button copies. In this repo they live
in `docs/agents/`. Each payload contains Step 0 (the rules that no API call can
state for itself) and the full matching quickstart. It works pasted into an
editor with no network access. All payloads are generated. To change one, edit
`docs/agents/src/<stack>.md` and run `npm run build:docs`. To hand an
agent a link instead, drop `/full` from the URL: that short page tells it to
download the full file with its shell.
