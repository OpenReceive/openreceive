# ADR-0008: Storage-free shipped routes

Status: Accepted; supersedes all earlier route/storage decisions in this file.

OpenReceive ships the routes in the OpenAPI 0.2 contract through Node adapters and Rails. The
host supplies authorization, amount resolution, and payment-hash commit hooks. Removed routes
include prepare, order/read models, checkout history, admin sweeps, and migration operations.

Capabilities and swap recovery are stateless authenticated encrypted tokens. No handler reads
or writes an OpenReceive store.
