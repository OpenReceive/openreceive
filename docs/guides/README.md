# OpenReceive guides

1. [Express quickstart (Node)](quickstart-node.md)
2. [Fastify quickstart](quickstart-fastify.md)
3. [Next.js quickstart](quickstart-next.md)
4. [Node ORM recipes](node-orms.md)
5. [Rails quickstart](quickstart-rails.md)
6. [BTCPay Server quickstart](quickstart-btcpay.md) — and its [reference](btcpay-reference.md)
7. [Authorization and the host](authorization.md)
8. [Rate limiting](rate-limiting.md)
9. [Frontend checkout](frontend-checkout.md)
10. [Checkout UX](checkout-ux.md)
11. [Headless checkout](headless-checkout.md)
12. [Writing your own checkout route](custom-checkout-route.md)
13. [Automated swaps](automated-swaps.md)
14. [Swap refunds, and the way back to them](swap-refunds.md)
15. [Lightning Swap Connect (LSC) URI](lightning-swap-connect.md)
16. [Environment variables](environment-variables.md)
17. [Payment storage](storage.md)
18. [Deploying OpenReceive](deploying.md)
19. [Testing your OpenReceive integration](host-testing.md)
20. [API reference](api-reference.md)
21. [Security](security.md)
22. [Price feeds](price-feeds.md)
23. [Provider registry](provider-registry.md)

Recipes: [React + Material UI](../recipes/react-material-ui.md)

Building this with a coding agent? Hand it one of the agent-directions
payloads instead of a reading list:
[Node (Express)](https://openreceive.org/agent-directions/node.md),
[Fastify](https://openreceive.org/agent-directions/fastify.md),
[Next.js](https://openreceive.org/agent-directions/next.md),
[Rails](https://openreceive.org/agent-directions/rails.md) or
[BTCPay Server](https://openreceive.org/agent-directions/btcpay.md) — the
byte-exact files behind the site's copy button (in this repo: `docs/agents/`).
Each is Step 0, the rules no API call can state for itself, and the matching
quickstart inlined in full, so it works pasted into an editor with no network
access. All five are generated — edit `docs/agents/src/<stack>.md` and run
`npm run build:docs`.
