import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { copyPaymentIconsPlugin } from "../../shared/copy-openreceive-payment-icons-plugin.ts";
import { createHelloFruitStaticServer } from "./src/server/create-server.ts";

const demoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoRoot, "../../../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const logLevel = env.LOG_LEVEL ?? process.env.LOG_LEVEL ?? "INFO";

  return {
    // Expose non-secret LOG_LEVEL to browser bundles (same value as server).
    envDir: repoRoot,
    envPrefix: ["VITE_", "LOG_"],
    define: {
      "import.meta.env.LOG_LEVEL": JSON.stringify(logLevel),
    },
    server: {
      fs: {
        allow: ["../../../.."],
      },
      // SQLite WAL/SHM under .openreceive must not trigger full page reloads mid-checkout.
      watch: {
        ignored: ["**/.openreceive/**"],
      },
    },
    plugins: [
      tailwindcss(),
      copyPaymentIconsPlugin(repoRoot),
      {
        name: "openreceive-hello-fruit-static-api",
        async configureServer(server) {
          server.middlewares.use(await createHelloFruitStaticServer());
        },
      },
    ],
  };
});
