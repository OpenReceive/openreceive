import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, test } from "@playwright/test";
import {
  addButtonToCart,
  expectWizardCurrencies,
  openShop,
  selectFrameworkTab,
  startCheckout,
} from "./helpers.ts";

/**
 * The shipped stylesheet must be inert outside OpenReceive-rendered subtrees.
 *
 * It is one Tailwind + daisyUI compile: preflight resets on `*`/`h1`/`img`/
 * `button`, a `:root` variable dump, and `.btn`/`.card`/`.modal` under their
 * generic names. Imported into a host page unscoped, it restyled the host —
 * and worse than specificity suggests, because its @layer blocks are declared
 * at import position and a later layer beats an earlier one outright. A host
 * whose own framework uses layers and is imported first (Mantine) lost every
 * padding the preflight zeroes: a SegmentedControl clipped "Pay with crypto"
 * to "Pay with crypt". tools/package/scope-styles.mjs now scopes every rule to
 * `[data-openreceive-root]`; this spec pins the host side of that contract.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const reactSheet = path.resolve(e2eDir, "../../packages/js/react/dist/styles.css");
const repoRoot = path.resolve(e2eDir, "../..");

/** The Mantine shape that caught this: host styles in a layer, imported first. */
const HOST_PAGE = `<!doctype html>
<html>
  <head>
    <style>
      @layer host;
      @layer host {
        h1 { font-size: 2em; margin: 0.67em 0; font-weight: 700; }
        .segment-label { display: inline-block; padding: 6px 16px; border: 1px solid #888; }
        img { display: inline; max-width: none; }
        a { color: rgb(0, 0, 238); }
      }
      /* A Bootstrap-ish button, unlayered, sharing daisyUI's class name. */
      .btn { display: inline-block; padding: 6px 12px; border: 1px solid #0d6efd; border-radius: 4px; background-color: rgb(13, 110, 253); color: rgb(255, 255, 255); }
      .card { padding: 20px; border: 2px solid #ccc; }
    </style>
  </head>
  <body>
    <h1 id="title">Host title</h1>
    <label class="segment-label" id="segment">Pay with crypto</label>
    <button class="btn" id="btn" type="button">Buy</button>
    <div class="card" id="card"><a id="link" href="#">link</a><img id="img" alt="" width="10" height="10"></div>
    <input id="input" type="text" value="v">
  </body>
</html>`;

const PROBES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["#title", ["fontSize", "marginTop", "marginBottom", "fontWeight"]],
  ["#segment", ["paddingLeft", "paddingRight", "borderTopWidth", "display"]],
  ["#btn", ["paddingLeft", "backgroundColor", "borderRadius", "borderTopColor", "color"]],
  ["#card", ["paddingTop", "borderTopWidth", "borderTopColor"]],
  ["#link", ["color"]],
  ["#img", ["display", "maxWidth"]],
  ["#input", ["borderTopWidth", "backgroundColor", "paddingLeft", "borderRadius"]],
  ["body", ["margin", "fontFamily", "lineHeight", "colorScheme"]],
];

async function computedProbes(page: import("@playwright/test").Page) {
  return page.evaluate((probes) => {
    const out: Record<string, Record<string, string>> = {};
    for (const [selector, properties] of probes) {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`missing ${selector}`);
      const style = getComputedStyle(element);
      out[selector] = Object.fromEntries(
        properties.map((property) => [
          property,
          style[property as keyof CSSStyleDeclaration] as string,
        ]),
      );
    }
    // The theme variable dump must not reach the document either.
    out[":root"] = {
      colorBase100: getComputedStyle(document.documentElement).getPropertyValue("--color-base-100"),
      fontSans: getComputedStyle(document.documentElement).getPropertyValue("--font-sans"),
    };
    return out;
  }, PROBES);
}

test("loading the stylesheet changes nothing on a host page it did not render", async ({
  page,
}) => {
  await page.setContent(HOST_PAGE);
  const before = await computedProbes(page);
  // Sanity: the fixtures carry the values the leak used to zero out.
  expect(before["#segment"]?.paddingLeft).toBe("16px");
  expect(before["#title"]?.marginTop).not.toBe("0px");

  await page.addStyleTag({ content: readFileSync(reactSheet, "utf8") });
  const after = await computedProbes(page);
  expect(after).toEqual(before);
});

test("the demo's Mantine tab strip keeps its padding while the checkout stays styled", async ({
  page,
}) => {
  await openShop(page);
  await addButtonToCart(page);
  await startCheckout(page);
  await selectFrameworkTab(page, "react");

  // Host side: the SegmentedControl label is a Mantine component styled from a
  // layered sheet imported before @openreceive/react/styles.css — exactly the
  // element the leak used to strip.
  const tab = page.locator(".or-shop-stage label", { hasText: "React" }).first();
  const tabPadding = await tab.evaluate((element) => getComputedStyle(element).paddingLeft);
  expect(Number.parseFloat(tabPadding)).toBeGreaterThan(0);

  // Library side: inside [data-openreceive-root] daisyUI still paints.
  const root = page.locator("[data-openreceive-root][data-openreceive-checkout]").first();
  await expect(root).toBeVisible();
  const rootStyles = await root.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      boxSizing: style.boxSizing,
      colorBase100: style.getPropertyValue("--color-base-100").trim(),
      dataTheme: element.getAttribute("data-theme"),
    };
  });
  expect(rootStyles.boxSizing).toBe("border-box");
  expect(rootStyles.colorBase100).not.toBe("");
  expect(rootStyles.dataTheme).toMatch(/^(light|dark)$/);
});

/** Compile tailwind-host.css the way a Tailwind v4 host's build would. */
function compileTailwindHostSheet(): string {
  const output = path.join(mkdtempSync(path.join(tmpdir(), "openreceive-tw-host-")), "host.css");
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules/@tailwindcss/cli/dist/index.mjs"),
      "-i",
      path.join(e2eDir, "tailwind-host.css"),
      "-o",
      output,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`tailwind host compile failed: ${result.stderr}`);
  const css = readFileSync(output, "utf8");
  // The collision this spec is about, present in the host sheet.
  expect(css).toMatch(/@layer utilities\s*\{[\s\S]*\.hidden\s*\{\s*display:\s*none/);
  return css;
}

/** Properties that decide what the payer sees. Widths follow from these (and a ticking countdown). */
const LAYOUT_PROPERTIES = [
  "display",
  "visibility",
  "position",
  "gridTemplateColumns",
  "flexDirection",
  "rowGap",
  "columnGap",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginLeft",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "color",
  "backgroundColor",
  "borderTopWidth",
  "borderTopColor",
  "borderTopLeftRadius",
  "opacity",
] as const;

/** Every element of the checkout, by document position, with its layout properties. */
function layoutSnapshot(root: Locator) {
  return root.evaluate((element, properties) => {
    const elements = [element, ...element.querySelectorAll("*")];
    return elements.map((node) => {
      const style = getComputedStyle(node);
      const label = `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`;
      return [
        label,
        Object.fromEntries(properties.map((property) => [property, style[property]])),
      ] as const;
    });
  }, LAYOUT_PROPERTIES);
}

test("a Tailwind host's own utilities cannot undo the checkout's layout", async ({ page }) => {
  // Desktop width: the network picker's wide copy is the one a host `.hidden` hid.
  await page.setViewportSize({ width: 1280, height: 900 });
  await openShop(page);
  await addButtonToCart(page);
  await startCheckout(page);
  await selectFrameworkTab(page, "react");
  await expectWizardCurrencies(page);

  const root = page.locator("[data-openreceive-root][data-openreceive-checkout]").first();
  // Mid-tween colours (a tile's `transition-colors` after the last click) are
  // not a layout change; measure settled values with no pointer over a tile.
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important}" });
  await page.mouse.move(0, 0);
  const before = await layoutSnapshot(root);
  // Appended last, like a host's own CSS bundle after @openreceive/react/styles.css.
  await page.addStyleTag({ content: compileTailwindHostSheet() });
  const after = await layoutSnapshot(root);
  const changed = after.flatMap(([label, style], index) =>
    Object.entries(style)
      .filter(([property, value]) => before[index]?.[1][property] !== value)
      .map(
        ([property, value]) => `${label} ${property}: ${before[index]?.[1][property]} → ${value}`,
      ),
  );
  expect(changed).toEqual([]);

  // The symptom from the Replit run: the USDT tile pressed, no network step.
  await page.getByRole("button", { name: /USDT/ }).click();
  await expect(page.getByRole("heading", { name: /Choose USDT network/ })).toBeVisible();
});
