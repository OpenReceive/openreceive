# @openreceive/svelte

Add Bitcoin Lightning checkout to your Svelte app with a ready-to-use
component. Give it an order reference to show payment choices, QR codes, and
live payment status. The component wraps the shared OpenReceive custom
element and fits into your existing checkout page.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

Pair this browser package with an OpenReceive server integration. Your server
authorizes the order, sets the amount, configures swaps, and verifies
settlement; wallet and provider credentials stay on the server.

## Install

Use Node.js 22 or later for package tooling and Svelte 5 or later.

```sh
npm install @openreceive/svelte
```

Follow the [frontend checkout guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/frontend-checkout.md)
to connect the component to your server routes. Use the server-side payment
hook to fulfill orders; browser callbacks update the interface.

## Mount

The component ships as a raw SFC on the `@openreceive/svelte/checkout.svelte`
subpath (your bundler's Svelte plugin compiles it); import the checkout styles
once.

```svelte
<script lang="ts">
import Checkout from "@openreceive/svelte/checkout.svelte";
// Scoped to what OpenReceive renders: safe next to any CSS framework, in any order.
import "@openreceive/svelte/styles.css";
</script>

<Checkout reference="order-123" onSettled={() => console.log("paid")} />
```

Pass `reference` to let the element create the checkout (create mode), or pass a
`checkout` snapshot to render one your server already created. Prop names,
defaults, and the full surface are shared across the wrappers — see
[frontend checkout guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/frontend-checkout.md).

Event handlers (`onCopy`, `onOpenWallet`, `onState`, `onSettled`,
`onProviderCopy`, `onStartOver`, `onError`) are ordinary props, not
framework-native events: pass them as props (`onSettled={handler}`), not with
`on:settled`. Each receives the DOM `CustomEvent` the element dispatches.

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).
