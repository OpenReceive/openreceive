// The checkout on a page with a Content-Security-Policy, in real browsers.
//
// Shops send one: Express apps through Helmet, Rails apps through the
// generated config/initializers/content_security_policy.rb, and many sites a
// strict same-origin policy. Our guides ask a shop for one thing only: allow
// `data:` in `img-src` (the wallet logos and tutorial pictures ship inside the
// JavaScript). Under each policy below, the payer must still get the whole
// checkout: the tiles, then the Lightning invoice with its QR code and the
// Copy invoice button, and the browser must report no policy violation. A
// blocked inline <style> or style attribute leaves the checkout unstyled
// without any error a shop would notice, so the violations are read from the
// page's own `securitypolicyviolation` events.
//
// The policy rides in a <meta http-equiv> tag, which carries every directive
// used here. Nothing on these pages is inline: the React mount and the page's
// own layout come from files, as a CSP host's would.

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
  launchEngine,
  openTab,
  requestedEngines,
  STANDALONE_SCRIPT,
} from "./helpers/real-browser-lab.mjs";

process.env.LOG_LEVEL ??= "error";
test.after(closeEngines);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCE = "order-csp";
const REQUIRE = process.env.OPENRECEIVE_BROWSER_TESTS === "require";

const POLICIES = [
  {
    // helmet() with no options (Helmet 8), minus the two directives a <meta>
    // tag cannot carry (frame-ancestors) or that would move this http page to
    // https (upgrade-insecure-requests).
    name: "Helmet's default policy (Express)",
    csp: [
      "default-src 'self'",
      "base-uri 'self'",
      "font-src 'self' https: data:",
      "form-action 'self'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "script-src-attr 'none'",
      "style-src 'self' https: 'unsafe-inline'",
    ].join("; "),
  },
  {
    // The policy `rails new` writes into config/initializers/content_security_policy.rb.
    name: "the policy Rails generates",
    csp: [
      "default-src 'self' https:",
      "font-src 'self' https: data:",
      "img-src 'self' https: data:",
      "object-src 'none'",
      "script-src 'self' https:",
      "style-src 'self' https:",
    ].join("; "),
  },
  {
    // Same origin for everything, and `data:` images because our guides ask for it.
    name: "a strict same-origin policy",
    csp: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
  },
];

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
      const bundle = lab.asset("react.js", await wrapperBundle("react"));
      const boot = lab.asset(
        "react-boot.js",
        `import "${bundle}";
window.mountCheckout(${JSON.stringify({ reference: REFERENCE, defaultTheme: "light" })}, { strict: false });
`,
      );
      return `<div id="app"></div><script type="module" src="${boot}"></script>`;
    },
  },
];

/** A document with no inline script, style or data: URL of its own. */
function cspDocument({ csp, head, body, layout, icon }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${csp === undefined ? "" : `<meta http-equiv="Content-Security-Policy" content="${csp}">`}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>browser lab: CSP</title>
<link rel="icon" href="${icon}">
<link rel="stylesheet" href="${layout}">
${head}
</head>
<body>
<div class="lab-column">${body}</div>
</body>
</html>`;
}

/** Runs in the page before any of its scripts. */
function recordViolations() {
  window.__cspViolations = [];
  document.addEventListener(
    "securitypolicyviolation",
    (event) => {
      window.__cspViolations.push(
        `${event.effectiveDirective} blocked ${event.blockedURI || "(inline)"}` +
          `${event.sourceFile ? ` from ${event.sourceFile}:${event.lineNumber}` : ""}` +
          `${event.sample ? ` [${event.sample}]` : ""}`,
      );
    },
    true,
  );
}

/** The QR code the invoice screen drew: the largest img, svg or canvas in the checkout. */
function drawnQr(scopeSelector) {
  const host = document.querySelector(scopeSelector);
  if (host === null) return null;
  const found = [];
  const walk = (root) => {
    for (const node of root.querySelectorAll("img, svg, canvas")) found.push(node);
    for (const node of root.querySelectorAll("*")) if (node.shadowRoot) walk(node.shadowRoot);
  };
  walk(host.shadowRoot ?? host);
  let best = null;
  for (const node of found) {
    const box = node.getBoundingClientRect();
    const area = box.width * box.height;
    if (best === null || area > best.area) {
      best = {
        area,
        width: Math.round(box.width),
        height: Math.round(box.height),
        tag: node.tagName.toLowerCase(),
        loaded: node.tagName === "IMG" ? node.complete && node.naturalWidth > 0 : true,
      };
    }
  }
  return best;
}

/**
 * The payer's two ways to pay, each to the screen with the QR code: Bitcoin to
 * the Lightning invoice, and SOL through Continue to the swap's deposit
 * instructions. Returns whether that screen's main action showed.
 */
const ROUTES = [
  {
    name: "Lightning",
    async pay(surface, scope) {
      await surface.bitcoin(scope).click();
      return scope.getByRole("button", { name: /Copy invoice/i }).first();
    },
  },
  {
    name: "a SOL swap",
    async pay(_surface, scope) {
      await scope.getByRole("button", { name: /^SOL/ }).first().click();
      await scope
        .getByRole("button", { name: /^Continue/ })
        .first()
        .click();
      return scope.getByText(/SOL on the Solana network/).first();
    },
  },
];

async function walk(browser, surface, route, csp) {
  const lab = await createLab();
  lab.stack.addOrder(REFERENCE, 2100);
  const tab = await openTab(browser, lab, { viewport: { width: 1280, height: 900 } });
  await tab.context.addInitScript(recordViolations);
  try {
    const layout = lab.asset("layout.css", ".lab-column { width: 440px; }", "text/css");
    const icon = lab.asset(
      "favicon.svg",
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "image/svg+xml",
    );
    await tab.page.goto(
      lab.page(
        cspDocument({
          csp,
          head: surface.head(lab),
          body: await surface.body(lab),
          layout,
          icon,
        }),
      ),
    );
    const scope = tab.page.locator(surface.scope);
    const bitcoin = surface.bitcoin(scope);
    await bitcoin.waitFor({ timeout: 15_000 });
    const tile = await bitcoin.evaluate((node) => {
      const style = getComputedStyle(node);
      return { borderTopWidth: style.borderTopWidth, display: style.display };
    });
    const action = await route.pay(surface, scope);
    const shown = await action
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    // The QR code is drawn after its screen shows; wait for it, not for a time.
    let qr = await tab.page.evaluate(drawnQr, surface.scope);
    const deadline = Date.now() + 10_000;
    while (!(qr !== null && qr.width >= 120 && qr.loaded) && Date.now() < deadline) {
      await tab.page.waitForTimeout(100);
      qr = await tab.page.evaluate(drawnQr, surface.scope);
    }
    return {
      tile,
      shown,
      qr,
      violations: await tab.page.evaluate(() => window.__cspViolations ?? []),
      complaints: tab.seen.complaints,
    };
  } finally {
    await tab.close();
    await lab.close();
  }
}

for (const engine of requestedEngines()) {
  for (const surface of SURFACES) {
    for (const route of ROUTES) {
      test(`${engine}: ${surface.name}, paying by ${route.name}, works under a shop's Content-Security-Policy`, async (t) => {
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
        const bare = await walk(browser, surface, route, undefined);
        assert.equal(bare.shown, true, `with no policy ${route.name} must reach its pay screen`);
        assert.ok(bare.qr !== null && bare.qr.width >= 120, "with no policy the QR code is drawn");
        for (const policy of POLICIES) {
          await t.test(policy.name, async () => {
            const result = await walk(browser, surface, route, policy.csp);
            assert.deepEqual(
              result.violations,
              [],
              `${policy.name}: the browser blocked part of the checkout`,
            );
            assert.deepEqual(result.tile, bare.tile, `${policy.name}: the tiles lost their styles`);
            assert.equal(
              result.shown,
              true,
              `${policy.name}: ${route.name} must reach its pay screen`,
            );
            assert.ok(result.qr !== null, `${policy.name}: no QR code on the pay screen`);
            assert.equal(result.qr.loaded, true, `${policy.name}: the QR image did not load`);
            assert.deepEqual(
              { width: result.qr.width, height: result.qr.height },
              { width: bare.qr.width, height: bare.qr.height },
              `${policy.name}: the QR code is not drawn at its size`,
            );
            assert.deepEqual(result.complaints, [], "nothing may reach the console");
          });
        }
      });
    }
  }
}
