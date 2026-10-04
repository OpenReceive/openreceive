import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  outDir: "dist",
  // tsup strips `node:` from every builtin import by default. node:sqlite (the
  // doctor's --db check) exists ONLY under the prefix: stripped, the published
  // CLI asked npm for a package called "sqlite" and crashed.
  removeNodeProtocol: false,
});
