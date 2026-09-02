# @openreceive/browser

Framework-free browser helpers for OpenReceive checkout: prepare/create calls, status polling, QR and wallet helpers.

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

## Icon assets

The payment-method icons (`btc`, `lightning`, `usdt`, …) are compiled into
this package's JavaScript — nothing to copy, serve, or configure, under any
bundler:

- The custom element (`@openreceive/elements`, and the Vue/Svelte/Angular
  wrappers over it) draws them inline in its shadow root from
  `paymentIconSvgs`.
- Everything that wants a URL — `@openreceive/react`, the display models,
  `getPaymentMethodIcon` and friends, your own `<img>` — gets the same icons
  from `paymentIconUrls` as `data:image/svg+xml` URIs. If your
  Content-Security-Policy `img-src` forbids `data:`, allow it, or pass
  `assetBaseUrl` / `resolveAssetUrl` and the icons are served as files
  instead (`dist/assets/icons/*.svg` still ships, keyed by
  `paymentIconPaths`).

`@openreceive/provider-data`'s wallet logos and pay tutorials are files
(PNG/WebP) your host serves; see
[docs/guides/provider-registry.md](../../../docs/guides/provider-registry.md#assets).
