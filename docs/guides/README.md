# OpenReceive Guides

Start here when you are integrating OpenReceive into an app.

1. [What Is OpenReceive](what-is.md) - product boundary and runtime model.
2. [Node Framework Quickstart](quickstart-node.md) - working backend and checkout path.
3. [Rails Quickstart](quickstart-rails.md) - mountable engine walkthrough.
4. [Authorization](authorization.md) - `authorize` presets, `getCheckoutAmount`, CSRF/CORS.
5. [Frontend Checkout](frontend-checkout.md) - browser helpers, React, and web components.
6. [Checkout Retries](checkout-retries.md) - expired invoices, order ids, and amount changes.
7. [Settlement Sweeps](settlement-sweeps.md) - how reconciliation runs and how to drive it on low-traffic sites.
8. [Automated Swaps](automated-swaps.md) - provider setup, payer flow, refunds, and settlement authority.
9. [Storage](storage.md) - `OPENRECEIVE_STORE`, namespaces, and production storage.
10. [API Reference](api-reference.md) - service methods, payloads, and app-facing packages.
11. [Security](security.md) - receive-only NWC codes, payment verification, and route protection.
12. [NWC Code Management](secret-management.md) - local and deployment NWC code handling.
13. [Provider Registry](provider-registry.md) - payment-route suggestions.
14. [Price Feeds](price-feeds.md) - fiat quotes and `amount_msats`.
15. [Mobile Apps](mobile-apps.md) - mobile checkout boundary.
16. [Language Support](language-support.md) - current Node support and other language status.

Contributor / adapter docs (route contract, golden vectors, ADRs) live under
[`docs/internal/`](../internal/README.md) — not required for integration.
