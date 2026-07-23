# OpenReceive Internal Docs

Start here when you are contributing to OpenReceive itself, or operating
swaps / settlement beyond the integrator happy path.

1. [Architecture Notes](architecture.md) - settlement authority, host coordination, NWC strategy, and package boundaries.
2. [Shipped Routes](shipped-routes.md) - OpenAPI route contract and host-hook boundary.
3. [Custom Controller Integration](custom-controller-integration.md) - escape hatch when not mounting shipped routes.
4. [Swap Operations](swap-operations.md) - host swap data, provider state, and refunds.
5. [Settlement Sweeps](settlement-sweeps.md) - host-payment reconciliation and low-traffic drivers.
6. [Deployment State](deployment-storage.md) - host-row guarantees and multi-instance rules.
7. [Scope Lock](scope-lock.md) - v0.1 release boundary.
8. [Conformance](conformance.md) - schemas, vectors, gates, mock wallet, and live wallet smoke.
9. [Test Command Map](test-command-map.md) - focused validation commands.
10. [Package Ownership Map](package-ownership.md) - package ownership lanes.
11. [Release Process](release-process.md) - release gate, workflow skeletons, and tags.
12. [Forbidden Without Approval](forbidden-without-approval.md) - changes that need explicit approval.
13. [ADRs](adr/) - durable architecture decisions.
