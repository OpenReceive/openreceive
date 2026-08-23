<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  createWrapperCheckoutShellBinding,
  defineElements,
  validateCheckoutProps,
  type WrapperCheckoutComponentProps,
} from "./index.js";

defineOptions({
  name: "Checkout",
});

// The props are DERIVED from the shared wrapper surface, not restated: prop
// names, types, and per-mode applicability live once in
// @openreceive/elements/wrapper-shared (snapshot mode = `checkout`, create mode
// = `orderId` + optional `prefix`), and docs/internal/wrapper-parity.md is the
// human-readable contract. `withDefaults` still spells the defaults out — a
// type carries none.
const props = withDefaults(defineProps<WrapperCheckoutComponentProps>(), {
  options: () => ({}),
  // Explicit undefined defaults suppress Vue's absent-Boolean-prop-to-false
  // coercion: an unbound boolean prop must stay undefined so the
  // `?? options.* ?? default` chains below see "not set", not "false".
  paymentWizard: undefined,
  themeToggle: undefined,
  syncUrl: undefined,
});

// Storage and matchMedia only exist in the browser: resolving the theme before mount
// would make a server-rendered shell disagree with the first client render.
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
  defineElements();
});

const shell = computed(() => {
  validateCheckoutProps({
    framework: "@openreceive/vue",
    checkout: props.checkout,
    orderId: props.orderId,
    metadata: props.metadata,
    syncUrl: props.syncUrl,
    resumePathPrefix: props.resumePathPrefix,
    routeOrderId: props.routeOrderId,
  });
  return createWrapperCheckoutShellBinding(props.checkout ?? null, {
    ...props.options,
    themeToggle: props.themeToggle ?? props.options.themeToggle ?? true,
    deferThemeResolution: !mounted.value,
    ...(props.orderId === undefined ? {} : { orderId: props.orderId }),
    ...(props.prefix === undefined ? {} : { prefix: props.prefix }),
    ...(props.paymentWizard === undefined ? {} : { paymentWizard: props.paymentWizard }),
    ...(props.decodeLinkUrl === undefined ? {} : { decodeLinkUrl: props.decodeLinkUrl }),
    ...(props.defaultTheme === undefined ? {} : { defaultTheme: props.defaultTheme }),
    ...(props.storageKey === undefined ? {} : { storageKey: props.storageKey }),
    ...(props.metadata === undefined ? {} : { metadata: props.metadata }),
    ...(props.syncUrl === undefined ? {} : { syncUrl: props.syncUrl }),
    ...(props.resumePathPrefix === undefined ? {} : { resumePathPrefix: props.resumePathPrefix }),
    ...(props.routeOrderId === undefined ? {} : { routeOrderId: props.routeOrderId }),
    ...(props.onCopy === undefined ? {} : { onCopy: props.onCopy }),
    ...(props.onOpenWallet === undefined ? {} : { onOpenWallet: props.onOpenWallet }),
    ...(props.onState === undefined ? {} : { onState: props.onState }),
    ...(props.onSettled === undefined ? {} : { onSettled: props.onSettled }),
    ...(props.onProviderCopy === undefined ? {} : { onProviderCopy: props.onProviderCopy }),
    ...(props.onStartOver === undefined ? {} : { onStartOver: props.onStartOver }),
    ...(props.onError === undefined ? {} : { onError: props.onError }),
  });
});
</script>

<template>
  <section v-bind="shell.rootAttributes">
    <component
      v-if="shell.themeToggle"
      :is="shell.themeToggle.tagName"
      v-bind="shell.themeToggle.attributes"
    />
    <component
      :is="shell.checkout.tagName"
      v-bind="shell.checkout.attributes"
      v-on="shell.checkout.listeners"
    />
  </section>
</template>
