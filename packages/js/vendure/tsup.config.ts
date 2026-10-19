import { defineConfig } from "tsup";

// Three entries. dist/index.js holds names and helpers with no Vendure
// import, so a storefront or a test can load it without Vendure.
// dist/plugin.js is what vendure-config imports: the plugin, its payment
// method handler, its routes, scheduled task and migration. Vendure, NestJS
// and the other OpenReceive packages stay external, so the plugin runs on the
// application's own copies. dist/enable-openreceive.js is the script that
// creates the payment method through the Admin API.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    plugin: "src/plugin.ts",
    "enable-openreceive": "src/enable-openreceive.ts",
  },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts", plugin: "src/plugin.ts" } },
  clean: true,
  splitting: true,
  target: "es2022",
  outDir: "dist",
  external: [/^@vendure\//, /^@nestjs\//, /^@openreceive\//],
});
