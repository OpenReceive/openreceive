import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { laravelFrontDoor } from "./vite/laravel-front-door.ts";

const demoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoRoot, "../../../..");

/**
 * Laravel's own Vite, as the FRONT DOOR in development.
 *
 * The Fastify demo routes its API paths into the framework from inside Vite's
 * dev server so one port carries the whole stack. PHP cannot be required into
 * a Node process, so this config does the next thing: a plugin spawns
 * `php artisan serve` on an internal port and forwards the paths the app owns
 * (`/`, `/checkout/:id`, `/shop`, `/openreceive`, `/images`, `/__testkit`) to
 * it, and writes the `public/hot` file Laravel's `@vite` directive reads so
 * the Blade shell points the browser back at this server for its modules.
 * One port, the same host code production runs — and the thing the E2E
 * harness boots with `DEMO_WALLET=testkit`.
 *
 * In production `vite build` emits public/build/ with the manifest the `@vite`
 * directive reads; Apache serves it from the container.
 */
export default defineConfig(({ mode, command }) => {
  const rootEnv = loadEnv(mode, repoRoot, "");
  const logLevel = process.env.LOG_LEVEL ?? rootEnv.LOG_LEVEL ?? "INFO";

  return {
    // Chunk urls are /build/… in production (Laravel serves public/build); the
    // dev server is the origin itself.
    base: command === "build" ? "/build/" : "/",
    appType: "custom",
    // public/ is Laravel's document root, not a static tree to copy into the build.
    publicDir: false,
    build: {
      manifest: "manifest.json",
      outDir: "public/build",
      emptyOutDir: true,
      chunkSizeWarningLimit: 900,
      rollupOptions: { input: "resources/js/main.tsx" },
    },
    // Expose non-secret LOG_LEVEL to browser bundles (same value as the server).
    envDir: repoRoot,
    envPrefix: ["VITE_", "LOG_"],
    define: { "import.meta.env.LOG_LEVEL": JSON.stringify(logLevel) },
    server: {
      // The shared client, the wire types and the images all live above this
      // directory. One copy, six readers.
      fs: { allow: ["../../../.."] },
      // SQLite WAL/SHM under .data must not trigger a full page reload
      // mid-checkout.
      watch: { ignored: ["**/.data/**", "**/vendor/**", "**/storage/**"] },
    },
    plugins: [react(), laravelFrontDoor({ demoRoot, rootEnv })],
  };
});
