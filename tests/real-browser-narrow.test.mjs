// The checkout on a 360 px phone, in real browsers: nothing may stick out of
// the checkout or be cut off, on any screen a payer reaches.
//
// The Android lab (tests/android) found the refund confirmation cut off on
// every phone: "Confirm refund to 9WzDXwBbmkg8ZTbNMqUxvQRAyr" and a button
// reading "Confirm refu". A Solana address has no break opportunity, so it
// widened its grid column past the checkout. The swap spec runs at 1280 px and
// the trial phone journey never reaches a refund, so nothing caught it. Desktop
// engines at 360 px show the same overflow, so this runs in the lab: the
// element and React's checkout, through the picker, the Lightning invoice, a
// SOL deposit, the refund form and the refund confirmation.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { wrapperBundle } from "./helpers/real-browser-bundles.mjs";
import {
  checkoutTag,
  closeEngines,
  createLab,
  documentHtml,
  launchEngine,
  openTab,
  requestedEngines,
  STANDALONE_SCRIPT,
} from "./helpers/real-browser-lab.mjs";

process.env.LOG_LEVEL ??= "error";
test.after(closeEngines);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRE = process.env.OPENRECEIVE_BROWSER_TESTS === "require";
const REFERENCE = "order-narrow";
const PHONE = { width: 360, height: 740 };
/** A real Solana address: 44 characters and not one place to break a line. */
const SOLANA_REFUND = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const SURFACES = [
  {
    name: "the element",
    scope: "openreceive-checkout",
    bitcoin: (scope) => scope.locator('[data-or-method="bitcoin"]').first(),
    head: () => "",
    body: () =>
      `${checkoutTag({ reference: REFERENCE })}<script type="module" src="${STANDALONE_SCRIPT}"></script>`,
  },
  {
    name: "React's checkout",
    scope: "[data-openreceive-root][data-openreceive-checkout]",
    bitcoin: (scope) => scope.getByRole("button", { name: /Bitcoin/ }).first(),
    available: () => existsSync(path.join(repoRoot, "packages/js/react/dist/styles.css")),
    unavailable: "packages/js/react/dist/styles.css is not built (npm run build:packages)",
    head: (lab) => {
      const styles = lab.asset(
        "react-styles.css",
        readFileSync(path.join(repoRoot, "packages/js/react/dist/styles.css"), "utf8"),
        "text/css",
      );
      return `<link rel="stylesheet" href="${styles}">`;
    },
    body: async (lab) => {
      const script = lab.asset("react.js", await wrapperBundle("react"));
      return `<div id="app"></div><script type="module">
import "${script}";
window.mountCheckout(${JSON.stringify({ reference: REFERENCE, defaultTheme: "light" })}, { strict: false });
</script>`;
    },
  },
];

/**
 * What sticks out of the checkout or is cut off inside it. Runs in the page.
 * Walks open shadow roots. An element counts when its box ends past the
 * checkout's right edge, or when it hides text it is too narrow for.
 */
function overflowing(selector) {
  const host = document.querySelector(selector);
  if (host === null) return ["the checkout is not on the page"];
  const edge = host.getBoundingClientRect().right + 1;
  const found = [];
  const label = (node) => {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    return `<${node.tagName.toLowerCase()} class="${String(node.className?.baseVal ?? node.className ?? "").slice(0, 60)}">${text}`;
  };
  const visit = (root) => {
    for (const node of root.querySelectorAll("*")) {
      if (node.shadowRoot) visit(node.shadowRoot);
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right > edge) {
        found.push(
          `${label(node)} ends at ${Math.round(box.right)} px, past the checkout's ${Math.round(edge - 1)} px`,
        );
        continue;
      }
      const clips =
        style.overflowX === "hidden" ||
        style.overflowX === "clip" ||
        style.textOverflow === "ellipsis";
      const hasText = [...node.childNodes].some(
        (child) => child.nodeType === 3 && child.textContent.trim() !== "",
      );
      if (clips && hasText && node.scrollWidth > node.clientWidth + 1) {
        found.push(
          `${label(node)} cuts off its text (${node.scrollWidth} px in ${node.clientWidth} px)`,
        );
      }
    }
  };
  visit(host.shadowRoot ?? host);
  // One line per element: a cut-off child also makes every ancestor stick out.
  return [...new Set(found)];
}

async function walk(browser, surface) {
  const lab = await createLab();
  lab.stack.addOrder(REFERENCE, 2100);
  lab.stack.swapProvider.forceRefundRequired("SOL_SOL");
  const tab = await openTab(browser, lab, { viewport: PHONE });
  const found = [];
  const check = async (screen) => {
    for (const hit of await tab.page.evaluate(overflowing, surface.scope))
      found.push(`${screen}: ${hit}`);
  };
  try {
    await tab.page.goto(
      lab.page(documentHtml({ head: surface.head(lab), body: await surface.body(lab) })),
    );
    const scope = tab.page.locator(surface.scope);
    await surface.bitcoin(scope).waitFor({ timeout: 15_000 });
    await check("the picker");

    await scope.getByRole("button", { name: /^SOL/ }).first().click();
    await scope
      .getByRole("button", { name: /^Continue/ })
      .first()
      .click();
    const refundAddress = scope.getByPlaceholder(/refund address/i).first();
    await refundAddress.waitFor({ state: "visible", timeout: 30_000 });
    await check("the refund form");
    await refundAddress.fill(SOLANA_REFUND);
    await scope
      .getByRole("button", { name: /Review refund address/i })
      .first()
      .click();
    await scope
      .getByRole("button", { name: /^Confirm refund/i })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await check("the refund confirmation");
    // The payer confirms an address they can read: all of it is on screen.
    const instruction = scope.getByText(/Confirm refund to/).first();
    const shown = await instruction.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const host = node.getRootNode().host ?? node.closest("[data-openreceive-root]");
      const edge = (host ?? document.body).getBoundingClientRect().right + 1;
      return [...range.getClientRects()].every((rect) => rect.right <= edge);
    });
    if (!shown) found.push("the refund confirmation: the address runs past the checkout's edge");
    return found;
  } finally {
    await tab.close();
    await lab.close();
  }
}

for (const engine of requestedEngines()) {
  for (const surface of SURFACES) {
    test(`${engine}: ${surface.name} fits a 360 px phone on every screen up to a refund`, async (t) => {
      const { browser, skip } = await launchEngine(engine);
      if (skip !== undefined) {
        t.skip(skip);
        return;
      }
      if (surface.available !== undefined && !surface.available()) {
        if (REQUIRE) assert.fail(surface.unavailable);
        t.skip(surface.unavailable);
        return;
      }
      assert.deepEqual(await walk(browser, surface), []);
    });
  }
}
