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
// = `reference` + optional `prefix`), and docs/internal/wrapper-parity.md is the
// human-readable contract. `withDefaults` still spells the defaults out — a
// type carries none. Resolving the imported type needs TypeScript, so the
// package build does it (tools/package/compile-vue-sfc.mjs) and ships
// dist/Checkout.js with runtime props: a shop's build never compiles this file.
const props = withDefaults(defineProps<WrapperCheckoutComponentProps>(), {
  options: () => ({}),
  // Explicit undefined defaults suppress Vue's absent-Boolean-prop-to-false
  // coercion: an unbound boolean prop must stay undefined so the
  // `?? options.* ?? default` chains below see "not set", not "false".
  paymentWizard: undefined,
  themeToggle: undefined,
  syncUrl: undefined,
  resumePaymentHash: undefined,
  resumePaymentRail: undefined,
  resumable: undefined,
});

// Storage and matchMedia only exist in the browser: resolving the theme before mount
// would make a server-rendered shell disagree with the first client render.
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
  defineElements();
});

/**
 * Bind each element input as an attribute: `^name` is how Vue spells the
 * `.attr` modifier at runtime, and its SSR renderer reads it too. Without it,
 * Vue sets a custom element's input as a DOM property whenever the element
 * has a property of that name. Every element has a read-only `prefix` (its
 * namespace prefix), so the assignment threw, Vue only warned, and the
 * checkout asked /openreceive instead of the prefix it was given (#132).
 *
 * A key that already carries a Vue modifier (`^` or `.`) is left as it is: a
 * host that patched this file to force attributes itself (nuxt-openreceive did,
 * before this fix) must not end up binding `^^prefix`.
 */
function asAttributes(
  attributes: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [
      name.startsWith("^") || name.startsWith(".") ? name : `^${name}`,
      value,
    ]),
  );
}

const shell = computed(() => {
  validateCheckoutProps({
    framework: "@openreceive/vue",
    checkout: props.checkout,
    reference: props.reference,
    metadata: props.metadata,
    syncUrl: props.syncUrl,
    resumePathPrefix: props.resumePathPrefix,
    routeReference: props.routeReference,
    resumePaymentHash: props.resumePaymentHash,
    resumePaymentRail: props.resumePaymentRail,
  });
  return createWrapperCheckoutShellBinding(props.checkout ?? null, {
    ...props.options,
    themeToggle: props.themeToggle ?? props.options.themeToggle ?? true,
    deferThemeResolution: !mounted.value,
    ...(props.reference === undefined ? {} : { reference: props.reference }),
    ...(props.prefix === undefined ? {} : { prefix: props.prefix }),
    ...(props.csrfHeader === undefined ? {} : { csrfHeader: props.csrfHeader }),
    ...(props.paymentWizard === undefined ? {} : { paymentWizard: props.paymentWizard }),
    ...(props.decodeLinkUrl === undefined ? {} : { decodeLinkUrl: props.decodeLinkUrl }),
    ...(props.defaultTheme === undefined ? {} : { defaultTheme: props.defaultTheme }),
    ...(props.storageKey === undefined ? {} : { storageKey: props.storageKey }),
    ...(props.metadata === undefined ? {} : { metadata: props.metadata }),
    ...(props.syncUrl === undefined ? {} : { syncUrl: props.syncUrl }),
    ...(props.resumePathPrefix === undefined ? {} : { resumePathPrefix: props.resumePathPrefix }),
    ...(props.routeReference === undefined ? {} : { routeReference: props.routeReference }),
    ...(props.resumePaymentHash === undefined
      ? {}
      : { resumePaymentHash: props.resumePaymentHash }),
    ...(props.resumePaymentRail === undefined
      ? {}
      : { resumePaymentRail: props.resumePaymentRail }),
    ...(props.resumable === undefined ? {} : { resumable: props.resumable }),
    ...(props.onCopy === undefined ? {} : { onCopy: props.onCopy }),
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
      v-bind="asAttributes(shell.themeToggle.attributes)"
    />
    <component
      :is="shell.checkout.tagName"
      v-bind="asAttributes(shell.checkout.attributes)"
      v-on="shell.checkout.listeners"
    />
  </section>
</template>
