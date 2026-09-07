import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * E2E harness for the Buy a Button Vite-hosted demos in testkit wallet mode.
 *
 * OPENRECEIVE_E2E_STACK picks the demo directory under
 * examples/buttons/server/: `node-express` (the default, and the only stack
 * with the four framework tabs the full matrix drives), `fastify` (the
 * minimal React host; the framework helpers tolerate its missing tab strip)
 * `fastapi` (the same minimal host in Python — its vite.config.ts spawns
 * `uv run uvicorn` and proxies the API paths to it) or `django` (the Rails
 * demo's shape in Python; its vite.config.ts spawns `manage.py runserver` the
 * same way, on SQLite under OPENRECEIVE_DEMO_DB), or `laravel` (the same shape
 * in PHP; its vite.config.ts spawns `php artisan serve`). They all boot the same way —
 * Vite is the front door in development, and the host's API rides inside it —
 * so one webServer command covers them.
 *
 * The webServer boots the demo's Vite dev entry directly (not through
 * `tools/run-with-root-env.mjs`, which hard-requires NWC_URI): with
 * DEMO_WALLET=testkit the server runs against the in-memory
 * `@openreceive/testkit` fakes — no NWC_URI, no network — and serves the
 * `/__testkit` control routes the specs drive.
 *
 * OPENRECEIVE_DEMO_DB points the store at a fresh temp dir per run. That
 * matters MORE than it did for Hello Fruit: this shop deliberately does not
 * wipe its database on boot, so without the override a test run would
 * accumulate orders in examples/buttons/.data and the acceptance demo would be
 * reading the suite's leftovers.
 */

const E2E_STACKS = [
  "node-express",
  "fastify",
  "fastapi",
  "django",
  "php-plain",
  "laravel",
] as const;
type E2eStack = (typeof E2E_STACKS)[number];

const stack = (process.env.OPENRECEIVE_E2E_STACK ?? "node-express") as E2eStack;
if (!E2E_STACKS.includes(stack)) {
  throw new Error(
    `OPENRECEIVE_E2E_STACK=${stack} is not one of ${E2E_STACKS.join(", ")}: the Next.js ` +
      `and Rails stacks are not Vite-hosted and have their own harnesses.`,
  );
}

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.resolve(e2eDir, `../../examples/buttons/server/${stack}`);

const databaseDir = mkdtempSync(path.join(tmpdir(), "openreceive-e2e-db-"));

const PORT = 4173;

export default defineConfig({
  testDir: e2eDir,
  outputDir: path.join(e2eDir, "test-results"),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  // One worker: the specs share a single demo server and its testkit wallet,
  // and /__testkit/swap-step selectors are wallet-global (pay_in_asset queues
  // apply to future attempts), so parallel specs could cross-script each other.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // The copy-invoice assertions read the clipboard back.
    permissions: ["clipboard-read", "clipboard-write"],
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort --configLoader runner`,
    cwd: demoDir,
    // /openreceive/rates only answers once the service booted against the fakes.
    url: `http://127.0.0.1:${PORT}/openreceive/rates`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Play the demo's console (boot, testkit, on_paid) and OpenReceive's INFO
    // lines next to the list reporter. Playwright swallows stdout by default.
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DEMO_WALLET: "testkit",
      OPENRECEIVE_DEMO_DB: databaseDir,
    },
  },
});
