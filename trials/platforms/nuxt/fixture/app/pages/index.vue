<script setup lang="ts">
const { data: products } = await useFetch("/api/products");
</script>

<template>
  <main>
    <h1>Widget Shop</h1>
    <ul>
      <li v-for="product in products" :key="product.id">
        {{ product.name }} — ${{ product.price }}
        <form method="post" action="/orders">
          <input type="hidden" name="product_id" :value="product.id">
          <button type="submit">Buy</button>
        </form>
      </li>
    </ul>
  </main>
</template>
