import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * Browser E2E for the BTCPay Server plugin, against the regtest stack in
 * packages/dotnet/docker (start it with up.sh). There is no webServer here: the
 * server under test is the official BTCPay image, and the wallet, provider and
 * payer are the stack's containers. Run with `npm run test:e2e:btcpay`, or inside
 * Docker with packages/dotnet/docker/browser-e2e.sh.
 *
 * Environment (defaults fit the stack's host port mappings):
 *   OPENRECEIVE_BTCPAY_URL              http://127.0.0.1:14180
 *   OPENRECEIVE_BTCPAY_EMAIL/PASSWORD   the e2e.sh user
 *   OPENRECEIVE_BTCPAY_API_KEY          else read from packages/dotnet/docker/.state/e2e-store
 *   OPENRECEIVE_E2E_TESTKIT_URL         http://127.0.0.1:17790
 *   OPENRECEIVE_E2E_TESTKIT_SPEND_URL   http://127.0.0.1:17791
 *   OPENRECEIVE_E2E_FAKELSC_URL         https://127.0.0.1:17788
 *   OPENRECEIVE_E2E_FAKELSC_HOST        fake-lsc:7788 (what BTCPay reaches the provider at)
 *   OPENRECEIVE_E2E_CUSTOMER_LND_URL    unset → pay through `docker run` on the compose network
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: e2eDir,
  outputDir: path.join(e2eDir, "test-results"),
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 0,
  // Serial by design: the specs build on one store and script a wallet-global fake provider.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.OPENRECEIVE_BTCPAY_URL ?? "http://127.0.0.1:14180",
    trace: "retain-on-failure",
    ignoreHTTPSErrors: true,
    permissions: ["clipboard-read", "clipboard-write"],
  },
});
