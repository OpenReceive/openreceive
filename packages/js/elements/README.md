# @openreceive/elements

The OpenReceive checkout custom element (`<openreceive-checkout>`) and theme toggle (`<openreceive-theme-toggle>`).

## Mount

```js
import { defineElements } from "@openreceive/elements";
import "@openreceive/elements/styles.css";

defineElements();
```

```html
<openreceive-checkout order-id="order-123"></openreceive-checkout>
```

The element creates the checkout for `order-id`, then renders and polls itself.
It dispatches plain DOM `CustomEvent`s (`openreceive-settled`,
`openreceive-error`, …); the Vue/Svelte/Angular wrapper packages expose those as
handler props over the shared binding in `src/wrapper-shared.ts`.

## Icon assets

The checkout loads its payment-method icons by URL at runtime; your app must
serve them where the resolution lands. See
[Icon assets in `@openreceive/browser`](https://github.com/openreceive/openreceive/blob/master/packages/js/browser/README.md#icon-assets)
for the per-bundler recipes.

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).
