import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  outDir: "dist",
  esbuildOptions(options) {
    // es2022 predates import attributes, so esbuild would silently strip the
    // `with { type: "json" }` attribute from the externalized registry import
    // and Node would then refuse to load the JSON. Every supported runtime
    // (Node >= 22 and evergreen bundlers) understands import attributes.
    options.supported = { ...options.supported, "import-attributes": true };
  },
  esbuildPlugins: [
    // Keep the ~57KB registry JSON out of the bundled index.js: the same file
    // already ships in dist for the ./registry.json subpath export, so the
    // bundle imports that copy instead of inlining a second one. The resolved
    // path is dist-relative because copy-static places the JSON at
    // dist/openreceive-providers.v4.json next to the emitted index.js.
    {
      name: "external-provider-registry-json",
      setup(build) {
        build.onResolve({ filter: /openreceive-providers\.v4\.json$/ }, () => ({
          path: "./openreceive-providers.v4.json",
          external: true,
        }));
      },
    },
  ],
});
