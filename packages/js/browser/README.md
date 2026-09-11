# @openreceive/browser

Build a Bitcoin Lightning checkout that fits your own design. OpenReceive
provides browser helpers for creating checkout sessions, following payment
status, displaying QR codes, and opening wallets, plus a headless checkout
engine for custom payment screens.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

Pair this browser package with an OpenReceive server integration. Your server
authorizes the order, sets the amount, configures swaps, and verifies
settlement; wallet and provider credentials stay on the server.

## Install

Use Node.js 22 or later for package tooling.

```sh
npm install @openreceive/browser
```

Follow the [frontend checkout guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/frontend-checkout.md)
to connect your UI to your server routes. Use the server-side payment
hook to fulfill orders; browser callbacks update the interface.

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).

## Two ways to integrate

- **Drop-in**: use `@openreceive/react` (`<Checkout>`) or `@openreceive/elements`
  (custom elements) for a complete checkout UI; this package's main entry adds
  the small helpers around them (prepare/create calls, `status`, QR, wallet,
  copy).
- **Headless**: build your own UI on the engine via
  `@openreceive/browser/headless` — a curated, semver-guaranteed surface
  (state machine, wizard/status/swap models, formatters, labels, styling
  tokens). See the
  [Headless checkout guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/headless-checkout.md);
  the buttons rails example is the flagship demo of this style.

There is no private subpath: `./headless` is both the integration surface and
the floor under `@openreceive/elements`, `@openreceive/react`, and the
vue/svelte/angular wrappers. It is curated symbol-by-symbol rather than a
re-export of the package, so a name that is not on it is package-private and
will move without notice.

## Images

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can defer tutorial screenshots until first open; single-file builds
(including the standalone checkout) include them upfront. If your
Content-Security-Policy has a strict `img-src`, allow `data:`.

- The payment-method icons (`btc`, `lightning`, `usdt`, …) are compiled into
  this package: the custom element (`@openreceive/elements`, and the
  Vue/Svelte/Angular wrappers over it) draws them inline in its shadow root
  from `paymentIconSvgs`, and everything that wants a URL —
  `@openreceive/react`, the display models, `getPaymentMethodIcon` and
  friends, your own `<img>` — gets them from `paymentIconUrls` as
  `data:image/svg+xml` URIs.
- The wallet logos and pay tutorials are `data:image/webp` URIs in
  `@openreceive/provider-data`; `/headless` re-exports
  `loadPayTutorialImages` / `payTutorialImage` for the lazy tutorial chunk.
  See [docs/guides/provider-registry.md](https://github.com/OpenReceive/openreceive/blob/master/docs/guides/provider-registry.md#assets).
