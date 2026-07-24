<script setup lang="ts">
import { computed, onMounted } from "vue";
import {
  createOpenReceiveVueCheckoutShellBinding,
  defineOpenReceiveElements,
  type CheckoutShellOptions,
  type CheckoutSnapshot
} from "./index.js";

defineOptions({
  name: "Checkout"
});

const props = withDefaults(
  defineProps<{
    // Snapshot mode: pass a `checkout` to render it directly.
    // Create mode: omit `checkout` and pass `orderId` (+ optional `prefix`); the underlying
    // <openreceive-checkout> element creates the checkout, then renders and polls itself.
    checkout?: CheckoutSnapshot;
    orderId?: string;
    prefix?: string;
    metadata?: Record<string, unknown>;
    orderUrl?: string;
    syncUrl?: boolean;
    resumePathPrefix?: string;
    routeOrderId?: string;
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
    ...(props.syncUrl === undefined ? {} : { syncUrl: props.syncUrl }),
    ...(props.resumePathPrefix === undefined ? {} : { resumePathPrefix: props.resumePathPrefix }),
    ...(props.routeOrderId === undefined ? {} : { routeOrderId: props.routeOrderId }),
    ...(props.onSettled === undefined ? {} : { onSettled: props.onSettled }),
    ...(props.onStartOver === undefined ? {} : { onStartOver: props.onStartOver }),
  })
);
</script>

<template>
  <section v-bind="shell.rootAttrs">
    <component
      v-if="shell.themeToggle"
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
