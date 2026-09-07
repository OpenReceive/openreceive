# OpenReceive guides

1. [Express quickstart (Node)](quickstart-node.md)
2. [Fastify quickstart](quickstart-fastify.md)
3. [Next.js quickstart](quickstart-next.md)
4. [Node ORM recipes](node-orms.md)
5. [Rails quickstart](quickstart-rails.md)
6. [FastAPI quickstart](quickstart-fastapi.md)
7. [Django quickstart](quickstart-django.md)
8. [PHP quickstart (plain PHP)](quickstart-php.md)
9. [Laravel quickstart](quickstart-laravel.md)
10. [BTCPay Server quickstart](quickstart-btcpay.md) — and its [reference](btcpay-reference.md)
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
22. [Deploying OpenReceive](deploying.md)
23. [Testing your OpenReceive integration](host-testing.md)
24. [API reference](api-reference.md)
25. [Security](security.md)
26. [Price feeds](price-feeds.md)
27. [Provider registry](provider-registry.md)

Recipes: [React + Material UI](../recipes/react-material-ui.md),
[Flask](../recipes/flask.md) (the Python engine as a Blueprint)

Building this with a coding agent? Hand it one of the agent-directions
payloads instead of a reading list:
[Node (Express)](https://openreceive.org/agent-directions/node.md),
[Fastify](https://openreceive.org/agent-directions/fastify.md),
[Next.js](https://openreceive.org/agent-directions/next.md),
[FastAPI](https://openreceive.org/agent-directions/fastapi.md),
[Django](https://openreceive.org/agent-directions/django.md),
[Rails](https://openreceive.org/agent-directions/rails.md),
[PHP](https://openreceive.org/agent-directions/php.md),
[Laravel](https://openreceive.org/agent-directions/laravel.md) or
[BTCPay Server](https://openreceive.org/agent-directions/btcpay.md) — the
byte-exact files behind the site's copy button (in this repo: `docs/agents/`).
Each is Step 0, the rules no API call can state for itself, and the matching
quickstart inlined in full, so it works pasted into an editor with no network
access. All eight are generated — edit `docs/agents/src/<stack>.md` and run
`npm run build:docs`.
