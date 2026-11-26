// The module mounts the payment routes at /openreceive/** and registers
// <OpenReceiveCheckout>. The hooks are in server/openreceive.ts.
export default defineNuxtConfig({
  modules: ["@openreceive/nuxt"],
  compatibilityDate: "2026-11-01",
  devtools: { enabled: false },
});
