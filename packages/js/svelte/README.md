# @openreceive/svelte

Svelte wrapper for the OpenReceive checkout custom element. Requires Svelte 5.

## Mount

The component ships as a raw SFC on the `@openreceive/svelte/checkout.svelte`
subpath (your bundler's Svelte plugin compiles it); import the checkout styles
once.

```svelte
<script lang="ts">
import Checkout from "@openreceive/svelte/checkout.svelte";
import "@openreceive/svelte/styles.css";
</script>

<Checkout reference="order-123" onSettled={() => console.log("paid")} />
```

Pass `reference` to let the element create the checkout (create mode), or pass a
`checkout` snapshot to render one your server already created. Prop names,
defaults, and the full surface are shared across the wrappers — see
`docs/internal/wrapper-parity.md` in the repository.

Event handlers (`onCopy`, `onOpenWallet`, `onState`, `onSettled`,
`onProviderCopy`, `onStartOver`, `onError`) are ordinary props, not
framework-native events: pass them as props (`onSettled={handler}`), not with
`on:settled`. Each receives the DOM `CustomEvent` the element dispatches.

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).
