# OpenReceive Internal Docs

Start here when you are contributing to OpenReceive itself, or operating
swaps / settlement beyond the integrator happy path.

1. [Architecture Notes](architecture.md) - settlement authority, host coordination, NWC strategy, and package boundaries.
2. [Shipped Routes](shipped-routes.md) - OpenAPI route contract and host-hook boundary.
3. [Node Integration Details](node-integration.md) - request flow, hooks, retries, and direct checkout beyond the Node quickstart.
4. [Swap Operations](swap-operations.md) - host swap data, provider state, and refunds.
5. [Settlement Sweeps](settlement-sweeps.md) - host-payment reconciliation and low-traffic drivers.
6. [Deployment State](deployment-storage.md) - host-row guarantees and multi-instance rules.
7. [Scope Lock](scope-lock.md) - the library-owned persistence boundary.
8. [Conformance](conformance.md) - schemas, vectors, gates, mock wallet, and live wallet smoke.
9. [Test Command Map](test-command-map.md) - focused validation commands.
10. [Package Ownership Map](package-ownership.md) - package ownership lanes.
11. [Framework Wrapper Parity](wrapper-parity.md) - the prop/default/event contract all four wrappers share.
12. [Headless Surface Inventory](headless-surface.md) - generated list of every `@openreceive/browser/headless` export.
13. [Checkout Design](checkout-design.md) - why the status model, deposit warnings, QR encoding, and refund staging work the way they do.
14. [Release Process](release-process.md) - the release runbook: prepare, gate, tag, approve the gem publish, npm publish, GitHub release.
15. [Forbidden Without Approval](forbidden-without-approval.md) - changes that need explicit approval.
16. [BTCPay Plugin Manual E2E Checklist](btcpay-e2e.md) - what only a real wallet, a real provider and the Nostr plugin can prove, per release.

The custom-route escape hatch moved to the developer guides:
[Writing your own checkout route](../guides/custom-checkout-route.md).
