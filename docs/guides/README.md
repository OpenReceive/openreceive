# OpenReceive Guides

Start here when you are integrating OpenReceive into an app.

## Day one

1. [What Is OpenReceive](what-is.md) — product boundary and runtime model.
2. [Node Quickstart](quickstart-node.md) — working backend and checkout path.
3. [Rails Quickstart](quickstart-rails.md) — mountable engine walkthrough.
4. [Authorization](authorization.md) — `authorize` presets, `prepareCheckout`, CSRF/CORS.
5. [Frontend Checkout](frontend-checkout.md) — browser helpers, React, and other frameworks.
6. [Security](security.md) — receive-only NWC codes, secrets, and settlement.

## When you need it

7. [Automated Swaps](automated-swaps.md) — provider YAML, payer flow, refunds.
8. [Storage](storage.md) — `DATABASE_URL` auto-adopt, `store`, namespaces.
9. [API Reference](api-reference.md) — service methods and app-facing packages.
10. [Provider Registry](provider-registry.md) — payment-route suggestions.
11. [Price Feeds](price-feeds.md) — fiat quotes and `amount_msats`.

**Languages:** Node is the v0.1 supported path; Rails is a second settlement
engine on the same contract. There is no Python or PHP package yet.

Contributor / operator docs (route contract, sweeps, swap runbooks, ADRs) live
under [`docs/internal/`](../internal/README.md) — not required for day-one
integration.
