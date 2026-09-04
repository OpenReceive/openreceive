# OpenReceive guides

1. [Node quickstart](quickstart-node.md)
2. [Node ORM recipes](node-orms.md)
3. [Rails quickstart](quickstart-rails.md)
4. [BTCPay Server quickstart](quickstart-btcpay.md) — and its [reference](btcpay-reference.md)
5. [Authorization and the host](authorization.md)
6. [Rate limiting](rate-limiting.md)
7. [Frontend checkout](frontend-checkout.md)
8. [Checkout UX](checkout-ux.md)
9. [Headless checkout](headless-checkout.md)
10. [Writing your own checkout route](custom-checkout-route.md)
11. [Automated swaps](automated-swaps.md)
12. [Swap refunds, and the way back to them](swap-refunds.md)
13. [Lightning Swap Connect (LSC) URI](lightning-swap-connect.md)
14. [Environment variables](environment-variables.md)
15. [Payment storage](storage.md)
16. [Deploying OpenReceive](deploying.md)
17. [Testing your OpenReceive integration](host-testing.md)
18. [API reference](api-reference.md)
19. [Security](security.md)
20. [Price feeds](price-feeds.md)
21. [Provider registry](provider-registry.md)

Recipes: [React + Material UI](../recipes/react-material-ui.md)

Building this with a coding agent? Hand it one of the agent-directions
payloads instead of a reading list:
[Node](https://openreceive.org/agent-directions/node.md),
[Rails](https://openreceive.org/agent-directions/rails.md) or
[BTCPay Server](https://openreceive.org/agent-directions/btcpay.md) — the
byte-exact files behind the site's copy button (in this repo: `docs/agents/`).
Each is Step 0, the rules no API call can state for itself, and the matching
quickstart inlined in full, so it works pasted into an editor with no network
access. All three are generated — edit `docs/agents/src/<stack>.md` and run
`npm run build:docs`.
