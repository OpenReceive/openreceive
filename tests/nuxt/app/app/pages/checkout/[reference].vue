<script setup lang="ts">
const route = useRoute();
const { data, error } = await useFetch(`/api/checkout/${route.params.reference}`);
if (error.value) {
  throw createError({ statusCode: 404, statusMessage: "Not found", fatal: true });
}
</script>

<template>
  <OpenReceiveCheckout v-if="data" :reference="data.reference" resumable />
</template>
