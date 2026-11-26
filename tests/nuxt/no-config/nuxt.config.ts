// The module in an app that has no server/openreceive.ts yet.
export default defineNuxtConfig({
  modules: ["@openreceive/nuxt"],
  compatibilityDate: "2026-11-01",
  devtools: { enabled: false },
  telemetry: false,
});
