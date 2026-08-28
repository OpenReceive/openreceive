import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { copyPaymentIconsPlugin } from "../../shared/copy-openreceive-payment-icons-plugin.ts";
import { createButtonsStaticServer } from "./src/server/create-server.ts";

const demoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoRoot, "../../../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const logLevel = env.LOG_LEVEL ?? process.env.LOG_LEVEL ?? "INFO";

  return {
    // Expose non-secret LOG_LEVEL to browser bundles (same value as the server).
    envDir: repoRoot,
    envPrefix: ["VITE_", "LOG_"],
    define: { "import.meta.env.LOG_LEVEL": JSON.stringify(logLevel) },
    server: {
      // The vanilla client, the wire types and the images live above this
      // directory. One copy, four readers.
      fs: { allow: ["../../../.."] },
      // SQLite WAL/SHM under .data must not trigger a full page reload
      // mid-checkout.
      watch: { ignored: ["**/.data/**"] },
    },
    plugins: [
      copyPaymentIconsPlugin(repoRoot),
      {
        name: "openreceive-buttons-static-api",
        async configureServer(server) {
          server.middlewares.use(await createButtonsStaticServer());
        },
      },
    ],
  };
});
