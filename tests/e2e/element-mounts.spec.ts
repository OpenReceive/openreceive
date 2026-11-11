import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "./page-checks.ts";

/**
 * Every way a host puts `<openreceive-checkout>` on a page, in a real browser,
 * against the standalone build hosts ship (`packages/js/elements/dist/standalone`).
 *
 * A browser runs the element's callbacks in an order that depends on how the
 * element arrived. Markup parsed before the script defines the element (every
 * module script, server rendering, a wrapper that defines on mount) and markup
 * inserted with innerHTML are UPGRADED: one attributeChangedCallback per
 * attribute already present, while connected, then connectedCallback. An
 * element made with createElement gets its callbacks while disconnected.
 * happy-dom, which runs the unit tests, skips the upgrade's attribute
 * callbacks, so only a browser shows the upgrade path. Issue #137: an upgrade
 * with both `reference` and `prefix` sent POST /checkouts/prepare twice and
 * aborted the first.
 *
 * Self-contained: the page, the script and the OpenReceive routes are all
 * served by `page.route` on an origin of their own, not by the demo server.
 */

const ORIGIN = "http://element-mounts.test";
const STANDALONE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/js/elements/dist/standalone/openreceive-checkout.js",
);

const SCRIPT = '<script type="module" src="/openreceive-checkout.js"></script>';
const WOOCOMMERCE_ATTRIBUTES =
  'resumable="true" reference="order-1" prefix="/openreceive" csrf-header="X-WP-Nonce"';

function element(attributes: string): string {
  return `<openreceive-checkout ${attributes}></openreceive-checkout>`;
}

const MOUNTS: Record<string, string> = {
  "markup before the module script (upgrade)":
    element('reference="order-1" prefix="/openreceive"') + SCRIPT,
  "markup with prefix before reference (upgrade)":
    element('prefix="/openreceive" reference="order-1"') + SCRIPT,
  "the WooCommerce and EDD markup (upgrade)": element(WOOCOMMERCE_ATTRIBUTES) + SCRIPT,
  "markup with reference only (upgrade)": element('reference="order-1"') + SCRIPT,
  "innerHTML after the script defined the element (upgrade)": `<div id="slot"></div>${SCRIPT}<script type="module">document.getElementById("slot").innerHTML = '${element(WOOCOMMERCE_ATTRIBUTES)}';</script>`,
  "createElement after the script defined the element": `${SCRIPT}<script type="module">const el = document.createElement("openreceive-checkout"); el.setAttribute("reference", "order-1"); el.setAttribute("prefix", "/openreceive"); document.body.append(el);</script>`,
};

interface PrepareLog {
  /** The reference of every POST /checkouts/prepare, in order. */
  readonly sent: string[];
  /** Prepare requests the browser gave up on (aborted or failed). */
  readonly failed: string[];
}

/** Serve `body` as the page, the standalone build, and a pending order's prepare. */
async function servePage(page: Page, body: string): Promise<PrepareLog> {
  const log: PrepareLog = { sent: [], failed: [] };
  page.on("requestfailed", (request) => {
    if (request.url().endsWith("/checkouts/prepare")) {
      log.failed.push(`${request.url()} ${request.failure()?.errorText ?? ""}`);
    }
  });
  const script = readFileSync(STANDALONE, "utf8");
  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta name="csrf-token" content="token"></head><body>${body}</body></html>`,
      });
    }
    if (pathname === "/openreceive-checkout.js") {
      return route.fulfill({ contentType: "text/javascript", body: script });
    }
    if (pathname === "/openreceive/checkouts/prepare") {
      const reference = String(request.postDataJSON()?.reference);
      log.sent.push(reference);
      // Slow enough that a second prepare would overlap the first, as a real
      // server's does.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return route
        .fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            reference,
            amount_msats: 10_000_000,
            fiat_quote: null,
            payment_methods: [],
          }),
        })
        .catch(() => {
          // The page already gave up on this request; `requestfailed` logged it.
        });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  return log;
}

for (const [mount, body] of Object.entries(MOUNTS)) {
  test(`${mount}: one prepare, none aborted @smoke`, async ({ page }) => {
    const prepares = await servePage(page, body);
    await page.goto(`${ORIGIN}/`);
    // The element prepared and drew its method grid: the count below is of a
    // checkout that really started.
    await expect(page.getByRole("heading", { name: "Pay this invoice" })).toBeVisible();
    // Give a second prepare time to show up before counting.
    await page.waitForTimeout(500);
    expect(prepares.failed).toEqual([]);
    expect(prepares.sent).toEqual(["order-1"]);
  });
}

test("a reference changed after the prepare prepares the new order @smoke", async ({ page }) => {
  const prepares = await servePage(
    page,
    element('reference="order-1" prefix="/openreceive"') + SCRIPT,
  );
  await page.goto(`${ORIGIN}/`);
  await expect(page.getByRole("heading", { name: "Pay this invoice" })).toBeVisible();
  await page.locator("openreceive-checkout").evaluate((el) => {
    el.setAttribute("reference", "order-2");
  });
  await expect.poll(() => prepares.sent).toEqual(["order-1", "order-2"]);
  expect(prepares.failed).toEqual([]);
});
