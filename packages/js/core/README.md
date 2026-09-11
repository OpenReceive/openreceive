# @openreceive/core

Build on the shared payment primitives behind OpenReceive: exact money
conversion, exchange rates, wallet response normalization, and settlement rules.
Use this package when building a custom integration; most applications should
start with an OpenReceive server adapter.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

## Install

This package is ESM-only and requires Node >= 22.

```sh
npm install @openreceive/core
```

Start with the [integration quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md)
and the [payment storage guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/storage.md).

Most applications never import this package directly: `@openreceive/node`,
`@openreceive/http`, and the framework adapters re-export what a host needs. Reach
for it when you are building your own integration and want the shared primitives
on their own — chiefly `parseNwcUri`, `classifyTransactionSettlement` and the
settlement finality rule, the money/decimal helpers, and `CachedPriceFeed`.

The [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md)
documents the host-facing surface (node, adapters, Rails) rather than these
primitives; the exported types are the source of truth for them.

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md).
