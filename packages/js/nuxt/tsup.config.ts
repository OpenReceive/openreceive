import { defineConfig } from "tsup";

// Four entries. dist/module.js is what nuxt.config's `modules` loads, at build
// time, with @nuxt/kit. dist/server.js is what the app's server/openreceive.ts
// imports: no @nuxt/kit, so the server bundle never carries the build tools.
// dist/runtime/* are the files the module registers: Nitro bundles the route
// handler and Vite the component, each resolving the `#openreceive/*` aliases
// the module sets, so those stay external here.
export default defineConfig({
  entry: {
    module: "src/module.ts",
    server: "src/server.ts",
    "runtime/handler": "src/runtime/handler.ts",
    "runtime/checkout": "src/runtime/checkout.ts",
    "runtime/stack": "src/runtime/stack.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: true,
  target: "es2022",
  outDir: "dist",
  external: [/^#/, /^@openreceive\//, /^@nuxt\//, "h3", "vue"],
});
