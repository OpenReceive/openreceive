// The shop for tests/nuxt/nuxt.test.mjs: the module with its routes moved to
// /pay, so the test sees the prefix reach both the route and the component.
export default defineNuxtConfig({
  modules: ["@openreceive/nuxt"],
  openreceive: { prefix: "/pay" },
  compatibilityDate: "2026-11-01",
  devtools: { enabled: false },
  telemetry: false,
});
