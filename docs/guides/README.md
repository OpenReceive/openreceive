# OpenReceive guides

1. [Node quickstart](quickstart-node.md)
2. [Node ORM recipes](node-orms.md)
3. [Rails quickstart](quickstart-rails.md)
4. [Authorization and the host](authorization.md)
5. [Rate limiting](rate-limiting.md)
6. [Frontend checkout](frontend-checkout.md)
7. [Checkout UX](checkout-ux.md)
8. [Headless checkout](headless-checkout.md)
9. [Writing your own checkout route](custom-checkout-route.md)
10. [Automated swaps](automated-swaps.md)
11. [Swap refunds, and the way back to them](swap-refunds.md)
12. [Lightning Swap Connect (LSC) URI](lightning-swap-connect.md)
13. [Environment variables](environment-variables.md)
14. [Payment storage](storage.md)
15. [Deploying OpenReceive](deploying.md)
16. [Testing your OpenReceive integration](host-testing.md)
17. [API reference](api-reference.md)
18. [Security](security.md)
19. [Price feeds](price-feeds.md)
20. [Provider registry](provider-registry.md)

Recipes: [React + Material UI](../recipes/react-material-ui.md)

Building this with a coding agent? Hand it one of the agent-directions
payloads instead of a reading list:
[Node](https://openreceive.org/agent-directions/node.md) or
[Rails](https://openreceive.org/agent-directions/rails.md) — the byte-exact
files behind the site's copy button (in this repo: `docs/agents/`). Each is Step 0, the rules no API call can state for
itself, and the matching quickstart inlined in full, so it works pasted into an
editor with no network access. Both are generated — edit
`docs/agents/src/<stack>.md` and run `npm run build:docs`.
