// The checkout's own accessibility, in real browsers: axe-core's WCAG 2 A and
// AA rules on every screen a payer sees, light and dark.
//
// The agent trials run axe on the shop they built (payer_accessibility) and
// found the coin picker's "Minimum amount" line at 55% opacity, under 4.5:1 on
// white, in three shops at once. Nothing in CI ran axe, so the colour reached a
// release. Here the element and React's checkout draw each screen on a bare
// page: the picker with networks under their minimums (the limit hints), the
// USDT network step, the Lightning invoice, a SOL swap's deposit, and the paid
// screen. A serious or critical axe violation inside the checkout fails.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const REQUIRE = process.env.OPENRECEIVE_BROWSER_TESTS === "require";
const REFERENCE = "order-axe";
const ORDER = 2100;
/**
 * The lab's test provider has no minimums, so the picker under them is made by
 * hand: the server's answer says USDT on Tron and on Ethereum are below their
 * provider minimum (as FixedFloat says of a $5 order), and USDT on Solana stays
 * open, so the network step shows two "Minimum amount" lines.
 */
const UNDER_MINIMUM = new Set(["USDT_TRON", "USDT_ETH"]);

function underMinimums(body) {
  for (const method of body.payment_methods ?? []) {
    if (!UNDER_MINIMUM.has(method.pay_in_asset)) continue;
    Object.assign(method, {
      available: false,
      unavailable_reason: "amount_too_small",
      unavailable_message: "This invoice is below the provider minimum.",
      minimum_invoice_amount_msats: body.amount_msats * 5,
    });
  }
  return body;
}

const SURFACES = [
  {
    name: "the element",
    scope: "openreceive-checkout",
    bitcoin: (scope) => scope.locator('[data-or-method="bitcoin"]').first(),
    head: () => "",
    body: (_lab, theme) =>
      `${checkoutTag({ reference: REFERENCE, "data-openreceive-theme": theme })}<script type="module" src="${STANDALONE_SCRIPT}"></script>`,
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
    body: async (lab, theme) => {
      const script = lab.asset("react.js", await wrapperBundle("react"));
      return `<div id="app"></div><script type="module">
import "${script}";
window.mountCheckout(${JSON.stringify({ reference: REFERENCE, defaultTheme: theme })}, { strict: false });
</script>`;
    },
  },
];

const THEMES = ["light", "dark"];

/** axe on the page; only what lies inside the checkout counts. */
async function axeHits(page, scopeSelector) {
  if (!(await page.evaluate(() => typeof window.axe === "object"))) {
    await page.addScriptTag({ content: AXE });
  }
  return page.evaluate(async (selector) => {
    const roots = [...document.querySelectorAll(selector)];
    const inside = (node) => {
      // A target inside a shadow root is a path: [host, ...selectors in the root].
      let first = Array.isArray(node.target) ? node.target[0] : node.target;
      if (Array.isArray(first)) first = first[0];
      const element = typeof first === "string" ? document.querySelector(first) : null;
      return element !== null && roots.some((root) => root === element || root.contains(element));
    };
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      resultTypes: ["violations"],
    });
    return result.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => {
        const nodes = violation.nodes.filter(inside);
        return nodes.length === 0
          ? undefined
          : `${violation.impact} ${violation.id} x${nodes.length}: ${String(nodes[0].html).slice(0, 160)}` +
              (nodes[0].any?.[0]?.message ? ` (${nodes[0].any[0].message.slice(0, 120)})` : "");
      })
      .filter((hit) => hit !== undefined);
  }, scopeSelector);
}

async function open(browser, surface, theme, { minimums = false } = {}) {
  const lab = await createLab();
  lab.stack.addOrder(REFERENCE, ORDER);
  const tab = await openTab(browser, lab, {
    viewport: { width: 520, height: 1000 },
    colorScheme: theme,
  });
  if (minimums) {
    await tab.page.route(`**${lab.prefix}/checkouts/prepare`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: underMinimums(await response.json()) });
    });
  }
  await tab.page.goto(
    lab.page(
      documentHtml({
        head: surface.head(lab),
        body: `<main><h1>Checkout</h1><div style="width: 440px">${await surface.body(lab, theme)}</div></main>`,
        htmlAttributes: `data-theme="${theme}"`,
      }),
    ),
  );
  const scope = tab.page.locator(surface.scope);
  await surface.bitcoin(scope).waitFor({ timeout: 15_000 });
  return {
    lab,
    tab,
    scope,
    async close() {
      await tab.close();
      await lab.close();
    },
  };
}

/** Every screen, as [name, hits]. */
async function screens(browser, surface, theme) {
  const found = [];
  const check = async (name, visit) => {
    for (const hit of await axeHits(visit.tab.page, surface.scope)) found.push(`${name}: ${hit}`);
  };

  let visit = await open(browser, surface, theme, { minimums: true });
  try {
    await check("the picker under the swap minimums", visit);
    await visit.scope.getByRole("button", { name: /^USDT/ }).first().click();
    await visit.scope
      .getByRole("group", { name: "Choose USDT network" })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    // The limit hint is the line the trials caught; it must be on screen here.
    await visit.scope
      .getByText(/Minimum amount/)
      .filter({ visible: true })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await check("the USDT network step", visit);
  } finally {
    await visit.close();
  }

  visit = await open(browser, surface, theme);
  try {
    await surface.bitcoin(visit.scope).click();
    await visit.scope
      .getByRole("button", { name: /Copy invoice/i })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await check("the Lightning invoice", visit);
    const minted = visit.lab
      .servedTo("/checkouts")
      .filter((entry) => entry.status === 200 || entry.status === 201)
      .map((entry) => entry.body.checkout.payment_hash);
    visit.lab.stack.wallet.settleInvoice({ payment_hash: minted[0] });
    await visit.scope
      .getByText(/Payment received|^Paid$/)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    await check("the paid screen", visit);
  } finally {
    await visit.close();
  }

  visit = await open(browser, surface, theme);
  try {
    await visit.scope.getByRole("button", { name: /^SOL/ }).first().click();
    await visit.scope
      .getByRole("button", { name: /^Continue/ })
      .first()
      .click();
    await visit.scope
      .getByText(/SOL on the Solana network/)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await check("the SOL deposit", visit);
  } finally {
    await visit.close();
  }
  return found;
}

for (const engine of requestedEngines()) {
  for (const surface of SURFACES) {
    for (const theme of THEMES) {
      test(`${engine}: ${surface.name}, ${theme}, has no serious WCAG 2 A/AA problem on any screen`, async (t) => {
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
        assert.deepEqual(await screens(browser, surface, theme), []);
      });
    }
  }
}
