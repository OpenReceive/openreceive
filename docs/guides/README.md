# OpenReceive guides

1. [Express quickstart (Node)](quickstart-node.md)
2. [Fastify quickstart](quickstart-fastify.md)
3. [Next.js quickstart](quickstart-next.md)
4. [Node ORM recipes](node-orms.md)
5. [Rails quickstart](quickstart-rails.md)
6. [FastAPI quickstart](quickstart-fastapi.md)
7. [Django quickstart](quickstart-django.md)
8. [PHP quickstart (plain PHP)](quickstart-php.md)
9. [BTCPay Server quickstart](quickstart-btcpay.md) — and its [reference](btcpay-reference.md)
10. [Authorization and the host](authorization.md)
11. [Rate limiting](rate-limiting.md)
12. [Frontend checkout](frontend-checkout.md)
13. [Checkout UX](checkout-ux.md)
14. [Headless checkout](headless-checkout.md)
15. [Writing your own checkout route](custom-checkout-route.md)
16. [Automated swaps](automated-swaps.md)
17. [Swap refunds, and the way back to them](swap-refunds.md)
18. [Lightning Swap Connect (LSC) URI](lightning-swap-connect.md)
19. [Environment variables](environment-variables.md)
20. [Payment storage](storage.md)
21. [Deploying OpenReceive](deploying.md)
22. [Testing your OpenReceive integration](host-testing.md)
23. [API reference](api-reference.md)
24. [Security](security.md)
25. [Price feeds](price-feeds.md)
26. [Provider registry](provider-registry.md)

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
[PHP](https://openreceive.org/agent-directions/php.md) or
[BTCPay Server](https://openreceive.org/agent-directions/btcpay.md) — the
byte-exact files behind the site's copy button (in this repo: `docs/agents/`).
Each is Step 0, the rules no API call can state for itself, and the matching
quickstart inlined in full, so it works pasted into an editor with no network
access. All eight are generated — edit `docs/agents/src/<stack>.md` and run
`npm run build:docs`.
