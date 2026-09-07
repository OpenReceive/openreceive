import { defineConfig } from "@playwright/test";

// The application and MySQL must already be running in Docker; this runner
// never starts a host WordPress server.
export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  use: {
    baseURL: process.env.OPENRECEIVE_WORDPRESS_URL ?? "http://localhost:3009",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
