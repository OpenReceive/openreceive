<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  createOpenReceiveWrapperCheckoutShellBinding,
  defineOpenReceiveElements,
  validateOpenReceiveWrapperCheckoutProps,
  type CheckoutShellOptions,
  type CheckoutSnapshot,
  type OpenReceiveThemePreference,
} from "./index.js";

defineOptions({
  name: "Checkout",
});

// Prop names, defaults, and per-mode applicability are the shared contract in
// docs/internal/wrapper-parity.md. Keep this list in step with it.
const props = withDefaults(
  defineProps<{
    // Snapshot mode: pass a `checkout` to render it directly.
    // Create mode: omit `checkout` and pass `orderId` (+ optional `prefix`); the underlying
    // <openreceive-checkout> element creates the checkout, then renders and polls itself.
    checkout?: CheckoutSnapshot;
    orderId?: string;
    prefix?: string;
    orderUrl?: string;
    paymentWizard?: boolean;
    decodeLinkUrl?: string;
    themeToggle?: boolean;
    defaultTheme?: OpenReceiveThemePreference;
    storageKey?: string;
    // Create mode only.
    metadata?: Record<string, unknown>;
    syncUrl?: boolean;
    resumePathPrefix?: string;
    routeOrderId?: string;
    onCopy?: (event: Event) => void;
    onOpenWallet?: (event: Event) => void;
    onState?: (event: Event) => void;
    onSettled?: (event: Event) => void;
    onProviderCopy?: (event: Event) => void;
    onStartOver?: (event: Event) => void;
    onError?: (event: Event) => void;
    options?: CheckoutShellOptions;
  }>(),
  {
    options: () => ({}),
    // Explicit undefined defaults suppress Vue's absent-Boolean-prop-to-false
    // coercion: an unbound boolean prop must stay undefined so the
    // `?? options.* ?? default` chains below see "not set", not "false".
    paymentWizard: undefined,
    themeToggle: undefined,
    syncUrl: undefined,
  },
);

// Storage and matchMedia only exist in the browser: resolving the theme before mount
// would make a server-rendered shell disagree with the first client render.
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
  defineOpenReceiveElements();
});

const shell = computed(() => {
  validateOpenReceiveWrapperCheckoutProps({
    framework: "@openreceive/vue",
    checkout: props.checkout,
    orderId: props.orderId,
    metadata: props.metadata,
    syncUrl: props.syncUrl,
    resumePathPrefix: props.resumePathPrefix,
    routeOrderId: props.routeOrderId,
  });
  return createOpenReceiveWrapperCheckoutShellBinding(props.checkout ?? null, {
    ...props.options,
    themeToggle: props.themeToggle ?? props.options.themeToggle ?? true,
    deferThemeResolution: !mounted.value,
    ...(props.orderId === undefined ? {} : { orderId: props.orderId }),
    ...(props.prefix === undefined ? {} : { prefix: props.prefix }),
    ...(props.orderUrl === undefined ? {} : { orderUrl: props.orderUrl }),
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
