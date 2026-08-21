import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * E2E harness for the node-express Hello Fruit demo in testkit wallet mode.
 *
 * The webServer boots the demo's vite dev entry directly (not through
 * `tools/run-with-root-env.mjs`, which hard-requires NWC_URI): with
 * DEMO_WALLET=testkit the server runs against the in-memory
 * `@openreceive/testkit` fakes — no NWC_URI, no network — and mounts the
 * `/__testkit` control routes the specs drive. OPENRECEIVE_DEMO_DB points the
 * demo's sqlite store at a fresh temp dir so runs never touch
 * examples/hello-fruit/.openreceive.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.resolve(e2eDir, "../../examples/hello-fruit/server/node-express");

// Fresh, hermetic sqlite location per run (the demo wipes its DB on boot; the
// temp dir keeps that wipe away from the repo checkout).
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
    // /rates only answers once the OpenReceive service booted against the fakes.
    url: `http://127.0.0.1:${PORT}/rates`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DEMO_WALLET: "testkit",
      OPENRECEIVE_DEMO_DB: databaseDir,
    },
  },
});
