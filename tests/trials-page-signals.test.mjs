// The payer walk's page watch (trials/harness/page-signals.ts): which requests
// count as abandoned checkout work, which console lines count as errors, the
// two polish checks it reports, and, in a real Chromium, that it watches pages
// in contexts made after it was installed (every walk step makes its own).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { closeEngines, launchEngine } from "./helpers/real-browser-lab.mjs";
import {
  checkoutWorkRoute,
  PAGE_SIGNAL_IDS,
  pageSignalChecks,
  reportableConsoleError,
  watchBrowserPages,
} from "../trials/harness/page-signals.ts";

test.after(closeEngines);

test("a prepare, create or swap POST is checkout work, wherever the shop routes it", () => {
  assert.equal(
    checkoutWorkRoute("POST", "https://shop.test/openreceive/checkouts/prepare"),
    "/openreceive/checkouts/prepare",
  );
  assert.equal(checkoutWorkRoute("POST", "https://shop.test/pay/checkouts"), "/pay/checkouts");
  assert.equal(checkoutWorkRoute("POST", "https://shop.test/pay/swaps/"), "/pay/swaps/");
  // WordPress with plain permalinks, and PrestaShop's module controller.
  assert.equal(
    checkoutWorkRoute("POST", "https://shop.test/?rest_route=/openreceive/v1/checkouts/prepare"),
    "/openreceive/v1/checkouts/prepare",
  );
  assert.equal(
    checkoutWorkRoute(
      "POST",
      "https://shop.test/index.php?fc=module&module=openreceive&path=/checkouts",
    ),
    "/checkouts",
  );
});

test("polls, reads and other methods are not checkout work", () => {
  assert.equal(
    checkoutWorkRoute("POST", "https://shop.test/openreceive/payments/check"),
    undefined,
  );
  assert.equal(
    checkoutWorkRoute("GET", "https://shop.test/openreceive/checkouts/prepare"),
    undefined,
  );
  assert.equal(checkoutWorkRoute("POST", "https://shop.test/openreceive/swaps/status"), undefined);
  assert.equal(checkoutWorkRoute("POST", "https://shop.test/cart/checkouts-summary"), undefined);
});

test("console errors count, Chromium's failed-resource lines and warnings do not", () => {
  assert.equal(reportableConsoleError("error", "TypeError: x is undefined"), true);
  assert.equal(
    reportableConsoleError(
      "error",
      "Failed to load resource: the server responded with a status of 503",
    ),
    false,
  );
  assert.equal(reportableConsoleError("warning", "checkout.error.reworded"), false);
});

test("a clean walk passes both checks; a dirty one names what happened", () => {
  const clean = pageSignalChecks({ uncaught: [], consoleErrors: [], abandoned: [] });
  assert.deepEqual(
    clean.map((check) => [check.id, check.severity, check.pass, check.evidence]),
    [
      [PAGE_SIGNAL_IDS.console, "polish", true, undefined],
      [PAGE_SIGNAL_IDS.abandoned, "polish", true, undefined],
    ],
  );
  const dirty = pageSignalChecks({
    uncaught: ["http://shop/order/1: boom"],
    consoleErrors: ["http://shop/order/1: Vue warn"],
    abandoned: ["http://shop/order/1: POST /openreceive/checkouts/prepare (net::ERR_ABORTED)"],
  });
  assert.equal(dirty[0].pass, false);
  assert.match(
    dirty[0].evidence,
    /uncaught http:\/\/shop\/order\/1: boom \| http:\/\/shop\/order\/1: Vue warn/,
  );
  assert.equal(dirty[1].pass, false);
  assert.match(dirty[1].evidence, /checkouts\/prepare \(net::ERR_ABORTED\)/);
});

test("the watch sees every page of every context made after it", async (t) => {
  const { browser, skip } = await launchEngine("chromium");
  if (skip !== undefined) {
    t.skip(skip);
    return;
  }
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><script>
        console.error("from the page");
        const controller = new AbortController();
        fetch("/openreceive/checkouts/prepare", { method: "POST", body: "{}", signal: controller.signal }).catch(() => {});
        setTimeout(() => controller.abort(), 50);
      </script>`);
      return;
    }
    // The prepare is never answered in time.
    setTimeout(() => response.writeHead(200).end("{}"), 2_000);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const signals = watchBrowserPages(browser);
  // Two fresh buyers, as two walk steps are.
  for (let buyer = 0; buyer < 2; buyer += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForTimeout(300);
    await context.close();
  }
  assert.equal(signals.consoleErrors.length, 2, signals.consoleErrors.join(" | "));
  assert.equal(signals.abandoned.length, 2, signals.abandoned.join(" | "));
  assert.match(signals.abandoned[0], /POST \/openreceive\/checkouts\/prepare/);
});
