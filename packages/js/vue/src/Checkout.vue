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
    checkout: CheckoutSnapshot;
    statusUrl?: string;
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
  createOpenReceiveVueCheckoutShellBinding(props.checkout, {
    ...props.options,
    ...(props.statusUrl === undefined ? {} : { statusUrl: props.statusUrl }),
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
