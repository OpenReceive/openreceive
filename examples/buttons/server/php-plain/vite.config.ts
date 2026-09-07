import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

const demoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoRoot, "../../../..");

/**
 * The paths the PHP front controller answers. Vite's dev server proxies only
 * these to `php -S`; everything else is the SPA. The same four prefixes the
 * Fastify and FastAPI stacks route into their apps.
 */
const API_PREFIXES = ["/shop", "/openreceive", "/images", "/__testkit"] as const;

/**
 * Where `php -S` listens behind Vite in development. Fixed rather than random
 * so the proxy table can be written at config time; override with
 * OPENRECEIVE_PHP_PORT when two checkouts share a machine.
 */
const backendPort = Number(process.env.OPENRECEIVE_PHP_PORT ?? 3108);

/**
 * THE STANDALONE CHECKOUT. A plain-PHP host has no bundler, so it does not
 * `import "@openreceive/elements"` — it unpacks the release's
 * `standalone-checkout-<version>.tar.gz` next to its other static files. This
 * demo does the same with the in-repo build of that tarball: the whole
 * `packages/js/elements/dist/standalone/` tree is copied into
 * `public/openreceive/` (gitignored), where PHP serves it, and the shared
 * vanilla client's `@openreceive/elements` import is pointed at the copied
 * file — an alias while Vite serves the page in development, an external
 * `import "/openreceive/openreceive-checkout.js"` in the built bundle. Either
 * way the payment step runs the bundler-less artefact and nothing from npm.
 */
const STANDALONE_SOURCE = path.join(repoRoot, "packages/js/elements/dist/standalone");
const STANDALONE_TARGET = path.join(demoRoot, "public/openreceive");
const STANDALONE_JS = "openreceive-checkout.js";
const STANDALONE_URL = `/openreceive/${STANDALONE_JS}`;

function copyStandaloneCheckout(): void {
  if (!existsSync(path.join(STANDALONE_SOURCE, STANDALONE_JS))) {
    throw new Error(
      `${path.relative(repoRoot, STANDALONE_SOURCE)} is missing. Run \`npm run build:packages\` ` +
        "at the repository root first — its last step writes the standalone checkout build.",
    );
  }
  rmSync(STANDALONE_TARGET, { recursive: true, force: true });
  mkdirSync(path.dirname(STANDALONE_TARGET), { recursive: true });
  cpSync(STANDALONE_SOURCE, STANDALONE_TARGET, { recursive: true });
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const logLevel = env.LOG_LEVEL ?? process.env.LOG_LEVEL ?? "INFO";
  copyStandaloneCheckout();

  return {
    // Expose non-secret LOG_LEVEL to browser bundles (same value as the server).
    envDir: repoRoot,
    envPrefix: ["VITE_", "LOG_"],
    define: { "import.meta.env.LOG_LEVEL": JSON.stringify(logLevel) },
    // public/ is PHP's docroot, not Vite's: it holds index.php and the
    // standalone checkout, and the build writes the shop INTO it (below).
    // Letting Vite treat it as publicDir would copy index.php into itself.
    publicDir: false,
    resolve: {
      // Development: the shared client's `@openreceive/elements` resolves to the
      // standalone file PHP serves — the same bytes, through Vite's module graph.
      alias:
        command === "serve"
          ? { "@openreceive/elements": path.join(STANDALONE_TARGET, STANDALONE_JS) }
          : {},
    },
    build: {
      // The built shop lands beside index.php; php -S serves both from one docroot.
      outDir: "public",
      emptyOutDir: false,
      rollupOptions: {
        // Production: the import stays a real `import` of the file PHP serves.
        external: ["@openreceive/elements"],
        output: { paths: { "@openreceive/elements": STANDALONE_URL } },
      },
    },
    server: {
      // The shared client, the wire types and the images all live above this
      // directory. One copy, every stack reads it.
      fs: { allow: ["../../../.."] },
      // SQLite WAL/SHM under .data and Composer's vendor/ must not trigger a
      // full page reload mid-checkout.
      watch: { ignored: ["**/.data/**", "**/vendor/**", "**/public/**"] },
      // In development Vite is the front door: the API paths go to php -S on
      // the port above, the SPA is served here. One URL, the same host code
      // production runs — the FastAPI stack's proxy trick with PHP behind it.
      proxy: Object.fromEntries(
        API_PREFIXES.map((prefix) => [prefix, { target: `http://127.0.0.1:${backendPort}` }]),
      ),
    },
    plugins: [phpServerPlugin()],
  };
});

/**
 * Boot the PHP host alongside the dev server, so `npx vite` brings up the
 * WHOLE stack — which is what the E2E harness (tests/e2e/playwright.config.ts)
 * relies on. `composer install` runs on first use when vendor/ is missing;
 * DEMO_WALLET / OPENRECEIVE_DEMO_DB pass straight through to PHP.
 */
function phpServerPlugin(): Plugin {
  let child: ChildProcess | undefined;
  const stop = () => {
    child?.kill();
    child = undefined;
  };
  return {
    name: "openreceive-buttons-php-server",
    apply: "serve",
    configureServer(server) {
      if (!existsSync(path.join(demoRoot, "vendor/autoload.php"))) {
        server.config.logger.info("composer install (vendor/ is missing)…");
        const install = spawnSync("composer", ["install", "--no-interaction", "--no-progress"], {
          cwd: demoRoot,
          stdio: "inherit",
        });
        if (install.status !== 0) throw new Error("composer install failed");
      }
      child = spawn(
        "php",
        ["-S", `127.0.0.1:${backendPort}`, "-t", "public", "public/index.php"],
        {
          cwd: demoRoot,
          stdio: "inherit",
          // A few workers so the browser's parallel asset fetches do not queue
          // behind a wallet call; php -S is still a development server.
          env: { ...process.env, PHP_CLI_SERVER_WORKERS: process.env.PHP_CLI_SERVER_WORKERS ?? "4" },
        },
      );
      child.on("exit", (code, signal) => {
        if (code !== null && code !== 0) {
          server.config.logger.error(`php -S exited with ${code ?? signal}`);
        }
      });
      server.httpServer?.once("close", stop);
      for (const signal of ["SIGINT", "SIGTERM", "exit"] as const) process.once(signal, stop);
    },
  };
}
