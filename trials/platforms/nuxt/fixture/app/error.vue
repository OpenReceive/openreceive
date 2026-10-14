<script setup lang="ts">
import type { NuxtError } from "#app";

defineProps<{ error: NuxtError }>();
</script>

<template>
  <main>
    <h1>{{ error.statusCode === 404 ? "Not found" : "Something went wrong" }}</h1>
    <p><NuxtLink to="/">Back to the shop</NuxtLink></p>
  </main>
</template>
