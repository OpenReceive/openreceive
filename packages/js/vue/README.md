# @openreceive/vue

Vue wrapper for the OpenReceive checkout custom element.

## Mount

The component ships as a raw SFC on the `@openreceive/vue/checkout.vue` subpath
(your bundler's Vue plugin compiles it); import the checkout styles once.

```vue
<script setup lang="ts">
import Checkout from "@openreceive/vue/checkout.vue";
// Scoped to what OpenReceive renders: safe next to any CSS framework, in any order.
import "@openreceive/vue/styles.css";
</script>

<template>
  <Checkout reference="order-123" :onSettled="() => console.log('paid')" />
</template>
```

Pass `reference` to let the element create the checkout (create mode), or pass a
`checkout` snapshot to render one your server already created. Prop names,
defaults, and the full surface are shared across the wrappers — see
`docs/internal/wrapper-parity.md` in the repository.

Event handlers (`onCopy`, `onOpenWallet`, `onState`, `onSettled`,
`onProviderCopy`, `onStartOver`, `onError`) are ordinary props, not
framework-native events: bind them as props (`:onSettled="handler"`), not with
`@settled`/`v-on`. Each receives the DOM `CustomEvent` the element dispatches.

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).
