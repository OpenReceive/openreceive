import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { copyProviderAssetsPlugin } from "../../shared/copy-openreceive-provider-assets-plugin.ts";
import { SHOP_FASTIFY_API_PREFIXES } from "../../shared/server-node/fastify-app.ts";
import { createButtonsFastifyServer } from "./src/server/create-server.ts";

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
      // directory. One copy, five readers.
      fs: { allow: ["../../../.."] },
      // SQLite WAL/SHM under .data must not trigger a full page reload
      // mid-checkout.
      watch: { ignored: ["**/.data/**"] },
    },
    plugins: [
      react(),
      copyProviderAssetsPlugin(repoRoot),
      {
        name: "openreceive-buttons-fastify-api",
        // An Express app is a Connect middleware, so the Express stacks hand
        // it to Vite whole. A Fastify instance is not, but it exposes its
        // router as a plain (req, res) function once it is ready — so the
        // dev server routes the API paths into Fastify and serves the SPA
        // itself. One port, one process, the same host code production runs.
        async configureServer(server) {
          const app = await createButtonsFastifyServer();
          await app.ready();
          server.middlewares.use((req, res, next) => {
            const pathname = (req.url ?? "/").split("?")[0] ?? "/";
            const owned = SHOP_FASTIFY_API_PREFIXES.some(
              (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
            );
            if (owned) app.routing(req, res);
            else next();
          });
        },
      },
    ],
  };
});
