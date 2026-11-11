// The checkout inside other people's CSS, in real browsers.
//
// A shop's page brings its own stylesheet, loaded around ours: Tailwind,
// Bootstrap, a WordPress theme, a CSS reset. The Tailwind `.hidden` collision
// (the Replit video: USDT pressed, no network step) only showed in one host's
// page. Here every surface we ship is drawn in each host sheet and compared
// with the same surface on a bare page: every element of the checkout must
// compute the same layout and typography, and the USDT tile must still open
// its network step.
//
// Surfaces: the element (shadow DOM: a host reaches it only through inherited
// properties, rem units, the tag itself and custom properties) and React's
// checkout (light DOM, styled by the scoped @openreceive/react/styles.css,
// which every host rule can reach).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const REFERENCE = "order-host-css";
const REQUIRE = process.env.OPENRECEIVE_BROWSER_TESTS === "require";

// ------------------------------------------------------------- host sheets

/** Tailwind v4 compiled the way a Tailwind host's build compiles it (tests/e2e/tailwind-host.css). */
function tailwindHost() {
  const output = path.join(mkdtempSync(path.join(tmpdir(), "openreceive-host-css-")), "host.css");
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules/@tailwindcss/cli/dist/index.mjs"),
      "-i",
      path.join(repoRoot, "tests/e2e/tailwind-host.css"),
      "-o",
      output,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`tailwind host compile failed: ${result.stderr}`);
  return readFileSync(output, "utf8");
}

/** The real Bootstrap 5 stylesheet: reboot, and `.btn`, `.card`, `.hidden`-like utilities. */
function bootstrapHost() {
  return readFileSync(
    path.join(repoRoot, "node_modules/bootstrap/dist/css/bootstrap.min.css"),
    "utf8",
  );
}

/** The global styles a WordPress block theme prints from its theme.json. */
const WORDPRESS_THEME = `
:root { --wp--preset--font-size--medium: 1.25rem; --wp--preset--spacing--40: 2rem; --wp--style--global--content-size: 645px; }
body { margin: 0; font-family: "Manrope", ui-sans-serif, system-ui, sans-serif; font-size: var(--wp--preset--font-size--medium); line-height: 1.7; letter-spacing: -0.1px; color: #111; background: #fff; }
:where(.wp-site-blocks) > * { margin-block-start: 1.2rem; margin-block-end: 0; }
h1, h2, h3 { font-weight: 400; line-height: 1.125; letter-spacing: -0.1px; }
h2 { font-size: 2.6rem; } h3 { font-size: 2rem; }
a { color: currentColor; text-decoration: underline; text-underline-offset: .2ex; }
:where(img) { height: auto; max-width: 100%; }
:where(svg) { vertical-align: middle; }
button, .wp-element-button { background: #111; color: #fff; border-width: 0; border-radius: 9999px; padding: .6rem 1rem; font-family: inherit; font-size: 1rem; line-height: inherit; text-transform: uppercase; letter-spacing: 1px; }
button:hover, .wp-element-button:hover { background: #333; }
input, select, textarea { font-family: inherit; font-size: inherit; border: 1px solid #ccc; border-radius: 0; padding: .9rem 1.1rem; }
ul, ol { padding-left: 1.5rem; }
p { margin-block: 0 1.2rem; }
`;

/** The reset most hand-written sites start from. */
const MODERN_RESET = `
*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; }
body { line-height: 1.5; -webkit-font-smoothing: antialiased; }
img, picture, video, canvas, svg { display: block; max-width: 100%; }
input, button, textarea, select { font: inherit; }
p, h1, h2, h3, h4, h5, h6 { overflow-wrap: break-word; }
ul, ol { list-style: none; padding: 0; }
button { background: none; border: 0; padding: 0; cursor: pointer; color: inherit; }
`;

/**
 * `layered`: the host's rules sit in cascade layers, as Tailwind's do. The
 * others are plain, unlayered CSS, and unlayered CSS beats every layered rule
 * whatever its specificity. That is how a React host restyles the checkout on
 * purpose (docs/guides/frontend-checkout.md, "Layout and surface": "write your
 * rule outside any @layer"), so React's light-DOM checkout is expected to take
 * a plain host sheet's `button` or `.btn` rules, and is held only to still
 * working under them. The element is held to looking the same under every
 * host: its shadow root is the boundary.
 */
const HOSTS = [
  { name: "a Tailwind v4 host", css: tailwindHost, layered: true },
  { name: "a Bootstrap 5 host", css: bootstrapHost, layered: false },
  { name: "a WordPress block theme", css: () => WORDPRESS_THEME, layered: false },
  { name: "a site on a modern CSS reset", css: () => MODERN_RESET, layered: false },
];

// ---------------------------------------------------------------- surfaces

const SURFACES = [
  {
    name: "the element",
    root: "element",
    async body() {
      return `${checkoutTag({ reference: REFERENCE })}<script type="module" src="${STANDALONE_SCRIPT}"></script>`;
    },
  },
  {
    name: "React's checkout",
    root: "react",
    available: () => existsSync(path.join(repoRoot, "packages/js/react/dist/styles.css")),
    unavailable: "packages/js/react/dist/styles.css is not built (npm run build:packages)",
    async head(lab) {
      const styles = lab.asset(
        "react-styles.css",
        readFileSync(path.join(repoRoot, "packages/js/react/dist/styles.css"), "utf8"),
        "text/css",
      );
      return `<link rel="stylesheet" href="${styles}">`;
    },
    async body(lab) {
      const script = lab.asset("react.js", await wrapperBundle("react"));
      return `<div id="app"></div><script type="module">
import "${script}";
window.mountCheckout(${JSON.stringify({ reference: REFERENCE, defaultTheme: "light" })}, { strict: false });
</script>`;
    },
  },
];

/** Settled computed styles of every element the checkout drew, by document position. */
function snapshot(root) {
  const PROPERTIES = [
    "display",
    "visibility",
    "position",
    "flexDirection",
    "rowGap",
    "columnGap",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
    "boxSizing",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "textTransform",
    "color",
    "backgroundColor",
    "borderTopWidth",
    "borderTopStyle",
    "borderTopColor",
    "borderTopLeftRadius",
    "opacity",
    "width",
    "height",
  ];
  const scope =
    root === "element"
      ? document.querySelector("openreceive-checkout")?.shadowRoot
      : document.querySelector("[data-openreceive-root][data-openreceive-checkout]");
  if (!scope) return { missing: true, nodes: [] };
  const nodes = [...scope.querySelectorAll("*")].filter(
    (node) => !(node instanceof HTMLStyleElement) && !(node instanceof HTMLScriptElement),
  );
  return {
    missing: false,
    nodes: nodes.map((node) => {
      const style = getComputedStyle(node);
      const label = `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}.${[...node.classList].slice(0, 3).join(".")}`;
      return [label, Object.fromEntries(PROPERTIES.map((name) => [name, style[name]]))];
    }),
  };
}

async function draw(browser, surface, hostCss) {
  const lab = await createLab();
  lab.stack.addOrder(REFERENCE, 2100);
  const tab = await openTab(browser, lab, { viewport: { width: 1280, height: 900 } });
  try {
    const head = [
      surface.head ? await surface.head(lab) : "",
      // A host's own sheet loads after ours, the way its bundle does.
      hostCss === "" ? "" : `<style>${hostCss}</style>`,
    ].join("\n");
    await tab.page.goto(
      lab.page(
        documentHtml({
          head,
          body: `<div style="width: 440px">${await surface.body(lab)}</div>`,
        }),
      ),
    );
    const scope =
      surface.root === "element"
        ? tab.page.locator("openreceive-checkout")
        : tab.page.locator("[data-openreceive-root][data-openreceive-checkout]");
    await scope.getByRole("button", { name: /USDT/ }).first().waitFor({ timeout: 15_000 });
    // Nothing mid-transition, and no pointer over a tile.
    await tab.page.mouse.move(0, 0);
    await tab.page.waitForTimeout(400);
    const styles = await tab.page.evaluate(snapshot, surface.root);
    // The symptom from the Replit video: USDT pressed, and the network step must appear.
    await scope.getByRole("button", { name: /USDT/ }).first().click();
    const networkStep = await scope
      .getByRole("heading", { name: /Choose USDT network/ })
      .waitFor({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    return { styles, networkStep, complaints: tab.seen.complaints };
  } finally {
    await tab.close();
    await lab.close();
  }
}

function differences(bare, hosted) {
  const changed = [];
  if (bare.nodes.length !== hosted.nodes.length) {
    changed.push(
      `the checkout drew ${hosted.nodes.length} elements instead of ${bare.nodes.length}`,
    );
  }
  const count = Math.min(bare.nodes.length, hosted.nodes.length);
  for (let index = 0; index < count; index += 1) {
    const [label, before] = bare.nodes[index];
    const [, after] = hosted.nodes[index];
    for (const [name, value] of Object.entries(before)) {
      if (after[name] !== value) changed.push(`${label} ${name}: ${value} -> ${after[name]}`);
    }
  }
  return changed;
}

for (const engine of requestedEngines()) {
  for (const surface of SURFACES) {
    test(`${engine}: ${surface.name} looks and works the same inside a host's CSS`, async (t) => {
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
      const bare = await draw(browser, surface, "");
      assert.equal(bare.styles.missing, false, "the checkout did not draw on a bare page");
      assert.equal(bare.networkStep, true, "on a bare page USDT must open its network step");
      for (const host of HOSTS) {
        await t.test(host.name, async () => {
          const hosted = await draw(browser, surface, host.css());
          assert.equal(hosted.networkStep, true, `${host.name}: USDT must open its network step`);
          if (surface.root === "element" || host.layered) {
            assert.deepEqual(
              differences(bare.styles, hosted.styles),
              [],
              `${host.name}: the host's CSS changed how ${surface.name} is drawn`,
            );
          }
          assert.deepEqual(hosted.complaints, [], "nothing may reach the console");
        });
      }
    });
  }
}
