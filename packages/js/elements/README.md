# @openreceive/elements

Add Bitcoin Lightning checkout to any website with
`<openreceive-checkout>`. The custom element displays payment choices, QR
codes, and live payment status, with no frontend framework required. It also
ships `<openreceive-theme-toggle>` for switching the checkout theme.

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
npm install @openreceive/elements
```

Follow the [frontend checkout guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/frontend-checkout.md)
to connect the component to your server routes. Use the server-side payment
hook to fulfill orders; browser callbacks update the interface.

## Mount

```js
import { defineElements } from "@openreceive/elements";
// Scoped to what OpenReceive renders: safe next to any CSS framework, in any order.
import "@openreceive/elements/styles.css";

// Registers <openreceive-checkout> and <openreceive-theme-toggle> with the
// browser. Until this runs, those tags are unknown markup and render as
// nothing; once it runs, every such tag on the page — already in the HTML or
// added later — becomes the live checkout UI. Call once per page.
defineElements();
```

```html
<openreceive-checkout reference="order-123"></openreceive-checkout>
```

The element creates the checkout for `reference`, then renders and polls itself.
It dispatches plain DOM `CustomEvent`s (`openreceive-settled`,
`openreceive-error`, …); the Vue/Svelte/Angular wrapper packages expose those as
handler props over the shared binding at
`@openreceive/elements/wrapper-shared`.

## Images

Everything the checkout draws — payment-method icons, wallet logos, pay
tutorials — ships inside the JavaScript; nothing to copy, serve or configure,
under any bundler. If your Content-Security-Policy has a strict `img-src`,
allow `data:`. See
[Images in `@openreceive/browser`](https://github.com/openreceive/openreceive/blob/master/packages/js/browser/README.md#images).

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).
