<script setup lang="ts">
// The order's own URL: a payer can reload or bookmark it to come back to a
// pending payment or a swap refund.
const route = useRoute();
const { data, error } = await useFetch(`/api/orders/${route.params.id}`);
if (error.value) {
  throw createError({ statusCode: 404, statusMessage: "Order not found", fatal: true });
}
const paid = ref(data.value?.paid ?? false);
</script>

<template>
  <template v-if="data">
    <h1>{{ data.name }}</h1>
    <p>${{ data.amount }} {{ data.currency }} · {{ paid ? "Paid, thank you." : "Awaiting payment" }}</p>
    <!-- onPaid has marked the order paid by the time the checkout shows settlement. -->
    <OpenReceiveCheckout v-if="!data.paid" :reference="data.reference" resumable
      :on-settled="() => (paid = true)" />
  </template>
</template>
