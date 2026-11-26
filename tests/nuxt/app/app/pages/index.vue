<script setup lang="ts">
// Buy places an order and opens its checkout by client-side navigation.
async function buy() {
  const { id } = await $fetch<{ id: string }>("/orders", { method: "POST" });
  await navigateTo(`/checkout/${id}`);
}
</script>

<template>
  <button type="button" @click="buy">Buy</button>
</template>
