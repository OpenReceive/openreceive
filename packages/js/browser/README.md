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
  the hello-fruit rails example is the flagship demo of this style.

The `./internal` subpath is wrapper plumbing for OpenReceive's own packages —
unstable, undocumented, and not for end-developer use.
