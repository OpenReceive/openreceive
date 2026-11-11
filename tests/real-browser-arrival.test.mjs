// How <openreceive-checkout> arrives on a page, in real browsers.
//
// The element's other tests (element-lifecycle, lifecycle, wrapper-behavior)
// build it one way: defineElements() first, then createElement, setAttribute,
// appendChild, inside happy-dom. A shop's page almost never does that. The tag
// is in the HTML before the module script runs, or a framework writes it with
// innerHTML, or clones it from a <template>; the browser then UPGRADES the
// element, calling attributeChangedCallback once per attribute while it is
// already connected, and connectedCallback last. happy-dom skips those
// callbacks, so nothing here could be seen from the other files (issue 137 was
// reported by a user on Nuxt and was true of every store plugin we ship).
//
// One rule for every arrival: the page asks the server to prepare the order
// once, under the prefix it was given, and nothing it started is abandoned.

import assert from "node:assert/strict";
import test from "node:test";
import { OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES } from "../packages/js/browser/src/headless.ts";
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
import { KNOWN_OPEN, whileOpen } from "./helpers/known-issues.mjs";
import { shippedCheckoutShapes, shippedCheckoutTags } from "./helpers/shipped-checkout-markup.mjs";

process.env.LOG_LEVEL ??= "error";
test.after(closeEngines);

const REFERENCE = "order-arrival";
const TILE = '[data-or-method="bitcoin"]';

/** The module script a plain page loads: it defines the element when it runs. */
const DEFINE = `<script type="module" src="${STANDALONE_SCRIPT}"></script>`;

/** A module script that runs `js` once the element is defined. */
function afterDefine(js) {
  return `<script type="module">
import "${STANDALONE_SCRIPT}";
await customElements.whenDefined("openreceive-checkout");
const slot = document.getElementById("slot");
${js}
</script>`;
}

const SLOT = '<main id="slot"></main><aside id="elsewhere"></aside>';

/**
 * Every ordinary way the tag reaches the document. `upgrades` is true where the
 * browser upgrades an element that already has its attributes and is already
 * connected, which is the order issue 137 is about; a function where the
 * engines differ.
 */
const ARRIVALS = [
  {
    name: "in the HTML, module script after it",
    who: "plain HTML, PHP, WordPress, Django, Rails, Laravel: the markup the guides print",
    upgrades: true,
    page: (lab, attributes) =>
      lab.page(documentHtml({ body: `${checkoutTag(attributes)}\n${DEFINE}` })),
  },
  {
    name: "in the HTML, parsed after the script ran",
    who: "a streamed page, or a script the browser already had cached",
    // Chromium and Firefox construct a defined element as the parser meets it
    // and hand it its attributes before it is connected. WebKit (27.2, measured
    // here) inserts it first and upgrades it, so in Safari "define the element
    // before the markup" does not avoid the upgrade order.
    upgrades: (engine) => engine === "webkit",
    page: (lab, attributes) =>
      lab.streamedPage(
        // The comment is padding: WebKit does not start parsing a document
        // until it has more than a few hundred bytes of it.
        (release) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="icon" href="data:,"><title>browser lab</title>
<!-- ${"streamed ".repeat(256)} -->
<script>
// A dynamic import: WebKit holds an async module script until the document
// has finished arriving, which this document does only once the script ran.
import("${STANDALONE_SCRIPT}")
  .then(() => customElements.whenDefined("openreceive-checkout"))
  .then(() => fetch("${release}"));
</script></head><body><p>The order</p>`,
        () => `<script>window.definedFirst = customElements.get("openreceive-checkout") !== undefined;</script>
${checkoutTag(attributes)}</body></html>`,
      ),
    // The arrival is only what it claims if the parser met a defined element.
    premise: (page) => page.evaluate(() => window.definedFirst === true),
  },
  {
    name: "innerHTML after the script ran",
    who: "htmx, Turbo Frames, jQuery .html(), Vue v-html, a WooCommerce fragment refresh",
    upgrades: true,
    page: (lab, attributes) =>
      lab.page(
        documentHtml({
          body: `${SLOT}${afterDefine(`slot.innerHTML = ${JSON.stringify(checkoutTag(attributes))};`)}`,
        }),
      ),
  },
  {
    name: "insertAdjacentHTML after the script ran",
    who: "Alpine, Stimulus, hand-written DOM code",
    upgrades: true,
    page: (lab, attributes) =>
      lab.page(
        documentHtml({
          body: `${SLOT}${afterDefine(
            `slot.insertAdjacentHTML("beforeend", ${JSON.stringify(checkoutTag(attributes))});`,
          )}`,
        }),
      ),
  },
  {
    name: "cloned from a <template>",
    who: "Vue's hoisted static markup, lit, Alpine x-if",
    upgrades: true,
    page: (lab, attributes) =>
      lab.page(
        documentHtml({
          body: `<template id="order">${checkoutTag(attributes)}</template>${SLOT}${afterDefine(
            `slot.appendChild(document.getElementById("order").content.cloneNode(true));`,
          )}`,
        }),
      ),
  },
  {
    name: "parsed in another document, then adopted",
    who: "Turbo Drive, htmx boost, swup: a fetched page swapped into this one",
    upgrades: true,
    page: (lab, attributes) =>
      lab.page(
        documentHtml({
          body: `${SLOT}${afterDefine(`const fetched = new DOMParser().parseFromString(
  ${JSON.stringify(`<body>${checkoutTag(attributes)}</body>`)}, "text/html");
slot.appendChild(document.adoptNode(fetched.body.firstElementChild));`)}`,
        }),
      ),
  },
  {
    name: "createElement, attributes, then appended",
    who: "Vue, Svelte and React rendering on the client once the element is defined",
    upgrades: false,
    page: (lab, attributes) =>
      lab.page(
        documentHtml({
          body: `${SLOT}${afterDefine(`const checkout = document.createElement("openreceive-checkout");
for (const [name, value] of Object.entries(${JSON.stringify(attributes)})) checkout.setAttribute(name, value);
slot.appendChild(checkout);`)}`,
        }),
      ),
  },
  {
    name: "appended empty, then given its attributes one at a time",
    who: "Angular, and DOM code that appends before it configures",
    upgrades: false,
    oneAtATime: true,
    page: (lab, attributes) =>
      lab.page(
        documentHtml({
          body: `${SLOT}${afterDefine(`const checkout = document.createElement("openreceive-checkout");
slot.appendChild(checkout);
for (const [name, value] of Object.entries(${JSON.stringify(attributes)})) checkout.setAttribute(name, value);`)}`,
        }),
      ),
  },
  {
    name: "rendered, then moved to another parent",
    who: "a framework re-parenting the node: Vue Teleport, a keyed list reorder, a modal opening",
    upgrades: false,
    page: (lab, attributes) =>
      lab.page(
        documentHtml({
          body: `${SLOT}${afterDefine(`slot.innerHTML = "";
const checkout = document.createElement("openreceive-checkout");
for (const [name, value] of Object.entries(${JSON.stringify(attributes)})) checkout.setAttribute(name, value);
slot.appendChild(checkout);
window.moveCheckout = () => document.getElementById("elsewhere").appendChild(checkout);`)}`,
        }),
      ),
    afterRender: (page) => page.evaluate(() => window.moveCheckout()),
  },
  {
    name: "rendered, then every attribute written again unchanged",
    who: "a framework re-render that sets attributes it already set: morphdom, idiomorph, Turbo morph",
    upgrades: false,
    page: (lab, attributes) =>
      lab.page(
        documentHtml({
          body: `${SLOT}${afterDefine(`const checkout = document.createElement("openreceive-checkout");
const written = ${JSON.stringify(attributes)};
for (const [name, value] of Object.entries(written)) checkout.setAttribute(name, value);
slot.appendChild(checkout);
window.rewrite = () => { for (const [name, value] of Object.entries(written)) checkout.setAttribute(name, value); };`)}`,
        }),
      ),
    afterRender: (page) => page.evaluate(() => window.rewrite()),
  },
];

/** A value for each attribute a shipped tag carries. `undefined` leaves the attribute off. */
function valueFor(name, lab) {
  switch (name) {
    case "reference":
      return REFERENCE;
    case "prefix":
      return lab.prefix;
    case "csrf-header":
      return "X-WP-Nonce";
    case "resumable":
      return "true";
    case "theme":
      return "dark";
    case "id":
      return "checkout";
    // A resume hash names an attempt the order already has. These pages open a
    // new order; tests/real-browser-reopen.test.mjs covers the return visit.
    case "resume-payment-hash":
    case "resume-payment-rail":
      return undefined;
    default:
      if (name.startsWith("data-")) return "https://shop.example/thank-you";
      throw new Error(`real-browser-arrival: no test value for the attribute ${name}`);
  }
}

function attributesFor(names, lab) {
  const attributes = {};
  for (const name of names) {
    const value = valueFor(name, lab);
    if (value !== undefined) attributes[name] = value;
  }
  return attributes;
}

/** `id` while it is listed as open, else undefined. */
const open = (id) => (KNOWN_OPEN[id] === undefined ? undefined : id);

/**
 * Which open bug, if any, this arrival of this tag trips today. Reads
 * KNOWN_OPEN, so deleting an entry there is all a fix has to do.
 *
 * Issue 137: an upgrade calls back for `reference` and for `prefix`, in either
 * order, and each callback starts a prepare of its own.
 */
function knownFor(arrival, names, engine) {
  if (!names.includes("reference") || !names.includes("prefix")) return undefined;
  if (arrival.oneAtATime) {
    return names.indexOf("reference") < names.indexOf("prefix")
      ? open("prefix-after-reference")
      : undefined;
  }
  const upgrades =
    typeof arrival.upgrades === "function" ? arrival.upgrades(engine) : arrival.upgrades;
  return upgrades ? open("issue-137") : undefined;
}

/** Wait until the page has stopped asking: no fetch pending, none new for a moment. */
async function quiet(tab) {
  let last = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 8000;
  for (;;) {
    const calls = await tab.fetches();
    const pending = calls.some((call) => call.outcome === "pending");
    if (calls.length !== last) {
      last = calls.length;
      stableSince = Date.now();
    }
    if (!pending && Date.now() - stableSince >= 250) return calls;
    if (Date.now() > deadline) return calls;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function arrive(t, browser, engine, arrival, names) {
  // A tag that names a prefix gets routes mounted away from the default, so a
  // request that ignored the attribute has nowhere to land. A tag without one
  // gets the default mount, as its page has.
  const lab = await createLab({
    ...(names.includes("prefix") ? { prefix: "/pay" } : {}),
    noSwapProvider: true,
  });
  lab.stack.addOrder(REFERENCE, 2100);
  const tab = await openTab(browser, lab);
  try {
    const attributes = attributesFor(names, lab);
    await tab.page.goto(arrival.page(lab, attributes));
    if (arrival.premise !== undefined) {
      assert.equal(
        await arrival.premise(tab.page),
        true,
        `${arrival.name}: the page did not load that way`,
      );
    }
    await tab.page
      .locator("openreceive-checkout")
      .locator(TILE)
      .waitFor({ state: "visible", timeout: 15_000 });
    await quiet(tab);
    if (arrival.afterRender !== undefined) {
      await arrival.afterRender(tab.page);
      await quiet(tab);
      await tab.page.locator("openreceive-checkout").locator(TILE).waitFor({ state: "visible" });
    }
    const calls = await tab.fetches();
    const wrote = `<openreceive-checkout ${Object.keys(attributes).join(" ")}>`;
    await whileOpen(t, knownFor(arrival, Object.keys(attributes), engine), () => {
      assert.deepEqual(
        calls
          .filter((call) => call.path.endsWith("/checkouts/prepare"))
          .map((call) => `${call.method} ${call.path} -> ${call.outcome}`),
        [`POST ${lab.prefix}/checkouts/prepare -> 200`],
        `${wrote}, ${arrival.name}: the page must prepare the order once. Every fetch it made: ` +
          JSON.stringify(calls),
      );
      assert.deepEqual(
        calls.filter((call) => !call.path.startsWith(`${lab.prefix}/`)),
        [],
        "no request may leave for a prefix the page did not name",
      );
      assert.deepEqual(
        calls.filter((call) => call.outcome === "aborted" || call.outcome === "failed"),
        [],
        "the page started a request and abandoned it",
      );
      assert.deepEqual(tab.seen.failed, [], "the browser reported a request that never finished");
      assert.equal(
        lab.servedTo("/checkouts/prepare").length,
        1,
        "the server must run prepare once: an aborted request still runs there",
      );
    });
    assert.deepEqual(tab.seen.refused, [], "no request may be refused");
    assert.deepEqual(
      tab.seen.complaints,
      [],
      "nothing may reach the console as a warning or error",
    );
  } finally {
    await tab.close();
    await lab.close();
  }
}

// ----------------------------------------------------------- what we ship

const KNOWN_ATTRIBUTES = new Set(Object.values(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES));
/** Attributes of every HTML element; the checkout does not read them and need not. */
const GLOBAL_ATTRIBUTES = new Set(["id", "class", "style", "slot", "hidden", "lang", "dir"]);

test("every checkout tag in the plugins, guides and directions can be read", () => {
  const { tags, unreadable } = shippedCheckoutTags();
  assert.deepEqual(
    unreadable,
    [],
    "tests/helpers/shipped-checkout-markup.mjs could not read these tags, so no browser test " +
      "loads them. Teach attributeNames() their syntax.",
  );
  assert.ok(tags.length >= 20, `expected the shipped tags, found ${tags.length}`);
  for (const kind of ["plugin", "guide", "starter"]) {
    assert.ok(
      tags.some((tag) => tag.kind === kind),
      `no checkout tag found in the ${kind} sources: did they move?`,
    );
  }
});

test("a shipped checkout tag carries only attributes the element reads", () => {
  for (const tag of shippedCheckoutTags().tags) {
    for (const name of tag.names) {
      assert.ok(
        KNOWN_ATTRIBUTES.has(name) || GLOBAL_ATTRIBUTES.has(name) || name.startsWith("data-"),
        `${tag.where} writes ${name}="…" on <openreceive-checkout>, which the element does not ` +
          "read: a typo, or an attribute that was renamed.",
      );
    }
  }
});

// ------------------------------------------------------------- the browsers

/** Written by hand: the orders of `reference` and `prefix`, and neither. */
const WRITTEN_SHAPES = [
  ["reference"],
  ["reference", "prefix"],
  ["prefix", "reference"],
  ["reference", "prefix", "csrf-header", "theme", "resumable"],
];

for (const engine of requestedEngines()) {
  test(`${engine}: the page prepares the order once, however the tag arrives`, {
    concurrency: 4,
    timeout: 240_000,
  }, async (t) => {
    const { browser, skip } = await launchEngine(engine);
    if (skip !== undefined) {
      t.skip(skip);
      return;
    }
    const cases = [];
    for (const arrival of ARRIVALS) {
      for (const names of WRITTEN_SHAPES) {
        cases.push(
          t.test(`<${names.join(" ")}> ${arrival.name}`, () =>
            arrive(t, browser, engine, arrival, names),
          ),
        );
      }
    }
    await Promise.all(cases);
  });

  // The tags we ship, loaded the way their pages load them: markup first, the
  // module script after.
  test(`${engine}: every checkout tag we ship prepares the order once`, {
    concurrency: 4,
    timeout: 240_000,
  }, async (t) => {
    const { browser, skip } = await launchEngine(engine);
    if (skip !== undefined) {
      t.skip(skip);
      return;
    }
    await Promise.all(
      shippedCheckoutShapes().map((shape) =>
        t.test(`<${shape.names.join(" ")}> as in ${shape.writtenBy[0]}`, () =>
          arrive(t, browser, engine, ARRIVALS[0], shape.names),
        ),
      ),
    );
  });
}
