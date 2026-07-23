# OpenReceive Internal Docs

Start here when you are contributing to OpenReceive itself, or operating
swaps / settlement beyond the integrator happy path.

1. [Architecture Notes](architecture.md) - settlement authority, host coordination, NWC strategy, and package boundaries.
2. [Shipped Routes](shipped-routes.md) - OpenAPI route contract and host-hook boundary.
3. [Node Integration Details](node-integration.md) - request flow, hooks, retries, and direct checkout beyond the Node quickstart.
4. [Custom Controller Integration](custom-controller-integration.md) - escape hatch when not mounting shipped routes.
5. [Swap Operations](swap-operations.md) - host swap data, provider state, and refunds.
6. [Settlement Sweeps](settlement-sweeps.md) - host-payment reconciliation and low-traffic drivers.
7. [Deployment State](deployment-storage.md) - host-row guarantees and multi-instance rules.
8. [Scope Lock](scope-lock.md) - v0.1 release boundary.
9. [Conformance](conformance.md) - schemas, vectors, gates, mock wallet, and live wallet smoke.
10. [Test Command Map](test-command-map.md) - focused validation commands.
11. [Package Ownership Map](package-ownership.md) - package ownership lanes.
12. [Release Process](release-process.md) - release gate, workflow skeletons, and tags.
13. [Forbidden Without Approval](forbidden-without-approval.md) - changes that need explicit approval.
14. [ADRs](adr/) - durable architecture decisions.
