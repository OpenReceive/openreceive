import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import { OPENRECEIVE_STYLE_ROOT_ATTRIBUTE } from "../packages/js/browser/src/internal/dom-contract.ts";
import { compiledStyles } from "../packages/js/browser/src/generated/compiled-styles.ts";
import {
  STYLE_ROOT_ATTRIBUTE,
  scopeSelectorList,
  scopeStyles,
} from "../tools/package/scope-styles.mjs";

const R = `:where([${STYLE_ROOT_ATTRIBUTE}])`;

test("the build-time scope marker is the DOM contract's marker", () => {
  assert.equal(STYLE_ROOT_ATTRIBUTE, OPENRECEIVE_STYLE_ROOT_ATTRIBUTE);
});

test("plain selectors get a zero-specificity self form and a descendant form", () => {
  assert.deepEqual(scopeSelectorList("h1"), [`${R}:is(h1)`, `${R} :is(h1)`]);
  assert.deepEqual(scopeSelectorList(".btn:hover"), [
    `${R}:is(.btn:hover)`,
    `${R} :is(.btn:hover)`,
  ]);
  // A complex selector rides along inside :is() with its own specificity intact.
  assert.deepEqual(scopeSelectorList(".card > .card-body"), [
    `${R}:is(.card > .card-body)`,
    `${R} :is(.card > .card-body)`,
  ]);
  // daisyUI stamps [data-theme] ON the root: the self form is what paints it.
  assert.deepEqual(scopeSelectorList("[data-theme=dark]"), [
    `${R}:is([data-theme=dark])`,
    `${R} :is([data-theme=dark])`,
  ]);
});

test("the universal reset and bare pseudo-elements keep the pseudo-element outside :is()", () => {
  assert.deepEqual(scopeSelectorList("*,:after,::backdrop"), [
    R,
    `${R} *`,
    `${R}:after`,
    `${R} *:after`,
    `${R}::backdrop`,
    `${R} *::backdrop`,
  ]);
  assert.deepEqual(scopeSelectorList("input::placeholder"), [
    `${R}:is(input)::placeholder`,
    `${R} :is(input)::placeholder`,
  ]);
  assert.deepEqual(scopeSelectorList("::-webkit-search-decoration"), [
    `${R}::-webkit-search-decoration`,
    `${R} *::-webkit-search-decoration`,
  ]);
  // daisyUI's breadcrumb separator: `li+:before` implies `li+*:before`. Splitting
  // the pseudo-element off must spell the `*` out, or the combinator dangles
  // inside :is() and the browser drops the selector (the separator vanished).
  assert.deepEqual(scopeSelectorList(".breadcrumbs>li+:before"), [
    `${R}:is(.breadcrumbs>li+*):before`,
    `${R} :is(.breadcrumbs>li+*):before`,
  ]);
  assert.deepEqual(scopeSelectorList(".a ::after"), [
    `${R}:is(.a *)::after`,
    `${R} :is(.a *)::after`,
  ]);
  assert.deepEqual(scopeSelectorList(":root>::before"), [`${R}>*::before`]);
});

test("html, body and :root become the root itself — self form only", () => {
  assert.deepEqual(scopeSelectorList("html"), [R]);
  assert.deepEqual(scopeSelectorList("body"), [R]);
  assert.deepEqual(scopeSelectorList(":root,:host"), [R]);
  assert.deepEqual(scopeSelectorList(":root .prose"), [`${R} .prose`]);
  assert.deepEqual(scopeSelectorList(":root:has(.modal[open])"), [`${R}:is(:has(.modal[open]))`]);
  assert.deepEqual(scopeSelectorList(":root:not(span)"), [`${R}:is(:not(span))`]);
  // daisyUI wraps the root in a forgiving list. The root entry comes out as the
  // plain root form; the rest of the list keeps :where()'s zero specificity.
  assert.deepEqual(scopeSelectorList(":where(:root)"), [R]);
  assert.deepEqual(scopeSelectorList(":where(:root,[data-theme])"), [
    R,
    `${R}:is(:where([data-theme]))`,
    `${R} :is(:where([data-theme]))`,
  ]);
  assert.deepEqual(scopeSelectorList(":is(html,.x) .y"), [
    `${R} .y`,
    `${R}:is(:is(.x) .y)`,
    `${R} :is(:is(.x) .y)`,
  ]);
  // Regression guard for the design: a descendant form of the light `:root`
  // palette would override the dark palette a [data-theme=dark] root's
  // children inherit.
  for (const selector of scopeSelectorList(":root,[data-theme=light]")) {
    assert.ok(!selector.startsWith(`${R} `) || selector.includes("[data-theme=light]"));
  }
});

test(":host rules are dropped and already-marked selectors pass through", () => {
  assert.deepEqual(scopeSelectorList(":host"), []);
  assert.deepEqual(scopeSelectorList(":host([hidden])"), []);
  assert.deepEqual(scopeSelectorList("[data-openreceive-qr] svg"), ["[data-openreceive-qr] svg"]);
});

test("scopeStyles recurses into at-rules, drops emptied rules, and leaves keyframes alone", () => {
  const scoped = scopeStyles(
    "@layer base{:host{display:block}h1{font-size:inherit}}" +
      "@media (hover:hover){@supports (color:red){.btn:hover{color:red}}}" +
      "@keyframes spin{from{opacity:0}to{opacity:1}}" +
      "@property --x{syntax:'*';inherits:false}",
  );
  assert.equal(
    scoped,
    `@layer base{${R}:is(h1),${R} :is(h1){font-size:inherit}}` +
      `@media (hover:hover){@supports (color:red){${R}:is(.btn:hover),${R} :is(.btn:hover){color:red}}}` +
      "@keyframes spin{from{opacity:0}to{opacity:1}}" +
      "@property --x{syntax:'*';inherits:false}",
  );
});

function everySelector(css) {
  const selectors = [];
  postcss.parse(css).walkRules((rule) => {
    let node = rule.parent;
    while (node && node.type !== "root") {
      if (node.type === "atrule" && /keyframes$/i.test(node.name)) return;
      node = node.parent;
    }
    selectors.push(...rule.selectors);
  });
  return selectors;
}

test("the shipped sheets are scoped; the shadow-DOM compile is not", () => {
  for (const file of [
    "packages/js/browser/src/styles.css",
    "packages/js/elements/src/styles.css",
    "packages/js/react/src/styles.css",
  ]) {
    const css = readFileSync(file, "utf8");
    const selectors = everySelector(css);
    assert.ok(selectors.length > 1000, `${file}: expected a full compile`);
    const unscoped = selectors.filter((selector) => !selector.includes("data-openreceive-"));
    assert.deepEqual(unscoped, [], `${file}: every selector must carry a scope marker`);
    const dangling = selectors.filter((selector) => /[>+~ ]\)/.test(selector));
    assert.deepEqual(dangling, [], `${file}: no combinator may dangle inside :is()`);
    // Every document-root reference was rewritten to the scope root, however
    // daisyUI wrapped it — an unreachable `:root` here means a rule nothing gets.
    const roots = selectors.filter((selector) => /:root|\bhtml\b|\bbody\b/.test(selector));
    assert.deepEqual(roots, [], `${file}: no selector may still reference the document root`);
    assert.ok(css.includes(`${R}:is(.btn)`), `${file}: daisyUI components must survive scoping`);
  }
  // Inside a shadow root the boundary is the scope and the preflight is wanted.
  assert.ok(compiledStyles.includes("*,:after,:before,::backdrop"));
  assert.ok(!compiledStyles.includes(STYLE_ROOT_ATTRIBUTE));
});
