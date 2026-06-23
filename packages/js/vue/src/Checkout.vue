<script setup lang="ts">
import { computed, onMounted } from "vue";
import {
  createOpenReceiveVueCheckoutShellBinding,
  defineOpenReceiveElements,
  type CheckoutShellOptions,
  type CheckoutSnapshot
} from "./index.js";

const props = withDefaults(
  defineProps<{
    snapshot: CheckoutSnapshot;
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
  createOpenReceiveVueCheckoutShellBinding(props.snapshot, props.options)
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
