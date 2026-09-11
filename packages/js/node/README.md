# @openreceive/node

Accept Bitcoin Lightning payments directly into a wallet you control from
your Node.js application. This package connects to your receive-only Nostr
Wallet Connect (NWC) wallet, creates invoices, checks settlement, and provides
the swap service and command-line tools.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

## Install

This package is ESM-only and requires Node >= 22.

```sh
npm install @openreceive/node
```

Start with the [integration quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md)
and the [payment storage guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/storage.md).

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).

## Choose your integration

For a web checkout, install `@openreceive/express`, `@openreceive/fastify`, or
`@openreceive/next`. They use this service and add payment persistence,
authorization, and mounted routes. For a custom Node.js host, compose the
service with `@openreceive/http`.

Use this package directly when you need the service or its types as part of
that integration. The service does not persist payment attempts on its own.
The normal HTTP integration records them in your existing database before
exposing payment instructions.

- **Connect your wallet:** set `NWC_URI` on the server to a receive-only NWC
  connection. Startup checks reject spend-capable connections by default.
- **Enable optional swaps:** configure your provider through `LSC_URI_PRIMARY`
  and optionally `LSC_URI_BACKUP`.
- **Keep your business logic:** the host controls orders, prices,
  authorization, and fulfillment.

## Guides

- [Environment and wallet configuration](https://github.com/openreceive/openreceive/blob/master/docs/guides/environment-variables.md)
- [Optional swaps](https://github.com/openreceive/openreceive/blob/master/docs/guides/automated-swaps.md)
- [Test with a fake wallet](https://github.com/openreceive/openreceive/blob/master/docs/guides/host-testing.md)
- [Deploy and reconcile payments](https://github.com/openreceive/openreceive/blob/master/docs/guides/deploying.md)
