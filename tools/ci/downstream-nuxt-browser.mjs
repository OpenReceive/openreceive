// The browser half of tools/ci/downstream-nuxt.sh: nuxt-openreceive's
// playground, built against this tree with its routes at /pay, opened the two
// ways a Nuxt shop opens a checkout.
//
// 1. Buy on the home page: client-side navigation to /checkout/<id>, a fresh
//    client mount of @openreceive/vue (where #132 dropped the prefix).
// 2. The same URL loaded directly: server-rendered, then hydrated.
//
// Each must send exactly one prepare, to /pay, and nothing to /openreceive;
// abandon no request; and log nothing to the console.
//
//   node --import tsx tools/ci/downstream-nuxt-browser.mjs http://127.0.0.1:3912

import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const base = process.argv[2];
if (base === undefined) throw new Error("usage: downstream-nuxt-browser.mjs <playground url>");
const PREFIX = "/pay";

function watch(page) {
  const seen = { prepares: [], wrongPrefix: [], failed: [], complaints: [] };
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.endsWith("/checkouts/prepare"))
      seen.prepares.push(`${request.method()} ${pathname}`);
    if (pathname.startsWith("/openreceive/")) seen.wrongPrefix.push(pathname);
  });
  page.on("requestfailed", (request) => {
    seen.failed.push(`${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ""}`);
  });
  page.on("pageerror", (error) => seen.complaints.push(`uncaught: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      seen.complaints.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  return seen;
}

async function settled(page, seen) {
  await page
    .locator("openreceive-checkout")
    .locator('[data-or-method="bitcoin"]')
    .waitFor({ state: "visible", timeout: 30_000 });
  // Room for a second prepare to show itself.
  await page.waitForTimeout(1_000);
  assert.deepEqual(seen.prepares, [`POST ${PREFIX}/checkouts/prepare`], "one prepare, under /pay");
  assert.deepEqual(seen.wrongPrefix, [], "nothing may go to the default /openreceive prefix");
  assert.deepEqual(seen.failed, [], "no request may be abandoned");
  assert.deepEqual(seen.complaints, [], "nothing may reach the console");
  assert.equal(
    await page.locator("openreceive-checkout").getAttribute("prefix"),
    PREFIX,
    "the element carries the module's prefix",
  );
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  let seen = watch(page);
  await page.goto(`${base}/`);
  await page.getByRole("button", { name: "Buy" }).click();
  await page.waitForURL(/\/checkout\//);
  await settled(page, seen);
  console.log(`client navigation: ${seen.prepares.join(", ")}`);

  const direct = await context.newPage();
  seen = watch(direct);
  await direct.goto(page.url());
  await settled(direct, seen);
  console.log(`server render + hydration: ${seen.prepares.join(", ")}`);
} finally {
  await browser.close();
}
