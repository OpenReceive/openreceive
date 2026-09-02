import path from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import react from "@vitejs/plugin-react";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv } from "vite";
import * as vueCompiler from "vue/compiler-sfc";
import { copyProviderAssetsPlugin } from "../../shared/copy-openreceive-provider-assets-plugin.ts";
import { createButtonsExpressServer } from "./src/server/create-server.ts";

const demoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoRoot, "../../../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const logLevel = env.LOG_LEVEL ?? process.env.LOG_LEVEL ?? "INFO";

  return {
    build: { chunkSizeWarningLimit: 900 },
    // Expose non-secret LOG_LEVEL to browser bundles (same value as the server).
    envDir: repoRoot,
    envPrefix: ["VITE_", "LOG_"],
    define: { "import.meta.env.LOG_LEVEL": JSON.stringify(logLevel) },
    server: {
      // The shared client, the wire types and the images all live above this
      // directory. One copy, four readers.
      fs: { allow: ["../../../.."] },
      // SQLite WAL/SHM under .data must not trigger a full page reload
      // mid-checkout.
      watch: { ignored: ["**/.data/**"] },
    },
    plugins: [
      vue({ compiler: vueCompiler }),
      svelte(),
      react(),
      copyProviderAssetsPlugin(repoRoot),
      {
        name: "openreceive-buttons-api",
        async configureServer(server) {
          server.middlewares.use(await createButtonsExpressServer());
        },
      },
    ],
  };
});
