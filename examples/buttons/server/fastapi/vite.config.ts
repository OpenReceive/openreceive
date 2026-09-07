import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { copyProviderAssetsPlugin } from "../../shared/copy-openreceive-provider-assets-plugin.ts";

const demoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoRoot, "../../../..");

/**
 * The paths the Python host answers. Vite's dev server proxies only these to
 * uvicorn; everything else is the SPA. The same four prefixes the Fastify
 * stack routes into its app — one list, one meaning.
 */
const API_PREFIXES = ["/shop", "/openreceive", "/images", "/__testkit"] as const;

/**
 * Where uvicorn listens behind Vite in development. Fixed rather than
 * random so the proxy table can be written at config time; override with
 * OPENRECEIVE_FASTAPI_PORT when two checkouts share a machine.
 */
const backendPort = Number(process.env.OPENRECEIVE_FASTAPI_PORT ?? 3107);

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
      // SQLite WAL/SHM under .data and the Python toolchain must not trigger
      // a full page reload mid-checkout.
      watch: { ignored: ["**/.data/**", "**/.venv/**", "**/__pycache__/**"] },
      // In development Vite is the front door: the API paths go to uvicorn
      // on the port above, the SPA is served here. One URL, the same host
      // code production runs — the Fastify stack's `app.routing` trick, with
      // a proxy standing in for the in-process router.
      proxy: Object.fromEntries(
        API_PREFIXES.map((prefix) => [prefix, { target: `http://127.0.0.1:${backendPort}` }]),
      ),
    },
    plugins: [react(), copyProviderAssetsPlugin(repoRoot), uvicornPlugin()],
  };
});

/**
 * Boot the Python host alongside the dev server, so `npx vite` brings up the
 * WHOLE stack — which is what the E2E harness (tests/e2e/playwright.config.ts)
 * relies on. `uv run --frozen` installs the demo's locked environment on
 * first use; DEMO_WALLET / OPENRECEIVE_DEMO_DB pass straight through.
 */
function uvicornPlugin(): Plugin {
  let child: ChildProcess | undefined;
  const stop = () => {
    child?.kill();
    child = undefined;
  };
  return {
    name: "openreceive-buttons-fastapi-server",
    apply: "serve",
    configureServer(server) {
      child = spawn(
        "uv",
        [
          "run",
          "--frozen",
          "uvicorn",
          "server.asgi:app",
          "--host",
          "127.0.0.1",
          "--port",
          String(backendPort),
        ],
        { cwd: demoRoot, stdio: "inherit", env: { ...process.env, PORT: String(backendPort) } },
      );
      child.on("exit", (code, signal) => {
        if (code !== null && code !== 0) {
          server.config.logger.error(`uvicorn exited with ${code ?? signal}`);
        }
      });
      server.httpServer?.once("close", stop);
      for (const signal of ["SIGINT", "SIGTERM", "exit"] as const) process.once(signal, stop);
    },
  };
}
