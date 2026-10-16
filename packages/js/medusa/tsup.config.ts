import { defineConfig } from "tsup";

// Two outputs. dist/ is the package's own entry: names and helpers with no
// Medusa import, so a storefront or a test can load it without Medusa.
// .medusa/server/src/ is where Medusa looks inside a plugin: it loads every
// api/**/route.js, jobs/*.js and migration-scripts/*.js there, and the
// payment module loads providers/openreceive/index.js through the package's
// export. Splitting keeps one copy of the shared runtime, so the routes, the
// job and the provider share one database pool and one wallet connection.
export default defineConfig([
  {
    // dist/enable-openreceive.js is the script `npx medusa exec` runs to
    // offer OpenReceive in every region.
    entry: {
      index: "src/index.ts",
      "enable-openreceive": "src/medusa/scripts/enable-openreceive.ts",
    },
    format: ["esm"],
    dts: { entry: { index: "src/index.ts" } },
    clean: true,
    target: "es2022",
    outDir: "dist",
    external: [/^@medusajs\//],
  },
  {
    entry: {
      "api/store/openreceive/[segment]/route":
        "src/medusa/api/store/openreceive/[segment]/route.ts",
      "api/store/openreceive/[segment]/[action]/route":
        "src/medusa/api/store/openreceive/[segment]/[action]/route.ts",
      "jobs/openreceive-reconcile": "src/medusa/jobs/openreceive-reconcile.ts",
      "migration-scripts/openreceive-payment-tables":
        "src/medusa/migration-scripts/openreceive-payment-tables.ts",
      "providers/openreceive/index": "src/medusa/providers/openreceive/index.ts",
    },
    format: ["esm"],
    dts: false,
    clean: true,
    splitting: true,
    target: "es2022",
    outDir: ".medusa/server/src",
    external: [/^@medusajs\//, /^@openreceive\//],
  },
]);
