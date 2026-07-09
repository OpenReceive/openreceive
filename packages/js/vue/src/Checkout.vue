<script setup lang="ts">
import { computed, onMounted } from "vue";
import {
  createOpenReceiveVueCheckoutShellBinding,
  defineOpenReceiveElements,
  type CheckoutShellOptions,
  type CheckoutSnapshot
} from "./index.js";

defineOptions({
  name: "OpenReceiveCheckout"
});

const props = withDefaults(
  defineProps<{
    // Snapshot mode: pass a `checkout` to render it directly (backward compatible).
    // Create mode: omit `checkout` and pass `orderId` (+ optional `prefix`); the underlying
    // <openreceive-checkout> element creates the checkout, then renders and polls itself.
    checkout?: CheckoutSnapshot;
    orderId?: string;
    prefix?: string;
    metadata?: Record<string, unknown>;
    orderUrl?: string;
    onSettled?: (event: Event) => void;
    onStartOver?: (event: Event) => void;
    options?: CheckoutShellOptions;
  }>(),
  {
    options: () => ({})
  }
);

onMounted(() => {
  defineOpenReceiveElements();
});

const shell = computed(() =>
  createOpenReceiveVueCheckoutShellBinding(props.checkout ?? null, {
    ...props.options,
    ...(props.orderId === undefined ? {} : { orderId: props.orderId }),
    ...(props.prefix === undefined ? {} : { prefix: props.prefix }),
    ...(props.metadata === undefined ? {} : { metadata: props.metadata }),
    ...(props.orderUrl === undefined ? {} : { orderUrl: props.orderUrl }),
    ...(props.onSettled === undefined ? {} : { onSettled: props.onSettled }),
    ...(props.onStartOver === undefined ? {} : { onStartOver: props.onStartOver })
  })
);
</script>

<template>
  <section v-bind="shell.rootAttrs">
    <component
      :is="shell.themeToggle.tagName"
      v-bind="shell.themeToggle.attrs"
    />
    <component
      :is="shell.checkout.tagName"
      v-bind="shell.checkout.attrs"
      v-on="shell.checkout.listeners"
    />
  </section>
</template>
