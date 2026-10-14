<script setup lang="ts">
const route = useRoute();
// During server rendering, useFetch passes the visitor's cookies to the API route.
const { data: order } = await useFetch(`/api/orders/${route.params.id}`);
if (!order.value) {
  throw createError({ statusCode: 404, statusMessage: "Not Found", fatal: true });
}
useHead({ title: `Order ${order.value.id}` });
</script>

<template>
  <main v-if="order">
    <h1>Order {{ order.id }}</h1>
    <p>{{ order.product_name }} — ${{ order.amount }} {{ order.currency }}</p>
    <p v-if="order.status === 'paid'">Paid.</p>
    <p v-else>Awaiting payment. Online payments are not set up yet.</p>
  </main>
</template>
