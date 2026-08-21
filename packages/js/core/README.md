# @openreceive/core

Shared OpenReceive primitives: NWC parsing, settlement rules, money math, rates, and error normalization.

This package is ESM-only and requires Node >= 22.

Most applications never import this package directly: `@openreceive/node`,
`@openreceive/http`, and the framework adapters re-export what a host needs. Reach
for it when you are building your own integration and want the shared primitives
on their own — chiefly `parseNwcUri`, `classifyTransactionSettlement` and the
settlement finality rule, the money/decimal helpers, and `CachedPriceFeed`.

The [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md)
documents the host-facing surface (node, adapters, Rails) rather than these
primitives; the exported types are the source of truth for them.

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md).
