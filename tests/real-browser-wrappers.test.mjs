// The framework wrappers in real browsers, with every prop set away from its
// default.
//
// tests/wrapper-behavior.test.mjs mounts Vue and Svelte in happy-dom with a
// `reference` and nothing else. Two things a shop's browser does are invisible
// there. A browser has DOM properties happy-dom lacks: `Element.prefix` is
// read-only, so Vue assigning the `prefix` prop to it loses the value (issue
// 132, found by a user who mounts the routes at /pay). And every wrapper
// defines the element when it mounts, which upgrades or re-attributes an
// element that is already in the page (issue 137).
//
// The rule that would have caught both: a prop that is not the default must
// reach the element as its attribute, and the page must then prepare the order
// once, under the prefix it was given.

import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
} from "../packages/js/browser/src/headless.ts";
import { createWrapperCheckoutShellBinding } from "../packages/js/elements/src/wrapper-shared.ts";
import { wrapperBundle } from "./helpers/real-browser-bundles.mjs";
import {
  closeEngines,
  createLab,
  documentHtml,
  launchEngine,
  openTab,
  requestedEngines,
} from "./helpers/real-browser-lab.mjs";
import { KNOWN_OPEN, whileOpen } from "./helpers/known-issues.mjs";

process.env.LOG_LEVEL ??= "error";
test.after(closeEngines);

const REFERENCE = "order-wrapped";
const PREFIX = "/pay";
const TILE = '[data-or-method="bitcoin"]';

/**
 * Create-mode props, none at its default. A prop left at its default proves
 * nothing: the element falls back to the same value when the prop is lost.
 */
const PROPS = {
  reference: REFERENCE,
  prefix: PREFIX,
  csrfHeader: "X-Shop-Token",
  resumable: true,
  routeReference: REFERENCE,
  decodeLinkUrl: "https://decode.example/tx",
  defaultTheme: "dark",
  storageKey: "shop-theme",
  metadata: { cart: "cart-7" },
};

/** What the shared binding says the element must carry for {@link PROPS}. */
const EXPECTED = createWrapperCheckoutShellBinding(null, { ...PROPS, themeToggle: true });

/** `id` while it is listed as open, else undefined. */
const open = (id) => (KNOWN_OPEN[id] === undefined ? undefined : id);

/**
 * Each wrapper, and which open bug (if any) each of its three checks trips
 * today. The rules read KNOWN_OPEN, so deleting an entry there is all a fix
 * has to do: the check then has to hold.
 */
const WRAPPERS = [
  {
    name: "Vue, rendered on the client",
    who: "a Vue SPA, <ClientOnly>, client-side navigation to the checkout page",
    bundle: "vue",
    // Issue 132: Vue assigns `prefix` to the read-only DOM property, so the
    // element never gets it. Once it does, this mount is an upgrade with both
    // attributes in place, which is issue 137.
    known: {
      attributes: () => open("issue-132"),
      prepare: () => open("issue-132") ?? open("issue-137"),
      console: () => open("issue-132"),
    },
  },
  {
    name: "Vue, server-rendered then hydrated",
    who: "Nuxt, and any Vue SSR page",
    bundle: "vue",
    hydrate: true,
    // The server-rendered attribute survives hydration, so the element has its
    // prefix; Vue still tries the DOM property and warns (issue 132).
    known: { prepare: () => open("issue-137"), console: () => open("issue-132") },
  },
  {
    name: "Svelte, rendered on the client",
    who: "a Svelte or SvelteKit page",
    bundle: "svelte",
    known: { prepare: () => open("issue-137") },
  },
  {
    name: "Angular",
    who: "an Angular application",
    bundle: "angular",
    // Angular renders the element once it is defined, connects it, then
    // writes its attributes one at a time.
    known: { prepare: () => open("prefix-after-reference") },
  },
  {
    // React draws the checkout itself: there is no element to carry attributes,
    // so only the requests and the console are checked. Mounted without
    // StrictMode, whose development-only second mount is React's doing.
    name: "React",
    who: "a React or Next.js page",
    bundle: "react",
    ownRenderer: true,
    known: {},
  },
];

/** Vue's server render of the same props: what Nuxt sends before any script runs. */
async function vueServerHtml(props) {
  // Imported here, in a process with no DOM: a server renders this component
  // exactly so. An import that reaches for `window` fails every Nuxt build.
  const vuePackage = new URL("../packages/js/vue/dist/Checkout.js", import.meta.url);
  const Checkout = (await import(vuePackage.href)).default;
  const { createSSRApp, h } = await import("vue");
  const { renderToString } = await import("vue/server-renderer");
  return renderToString(createSSRApp({ render: () => h(Checkout, props) }));
}

/** Wait until the page has stopped asking: at least one prepare answered, then quiet. */
async function quiet(tab) {
  let last = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 15_000;
  for (;;) {
    const calls = await tab.fetches();
    const asked = calls.some((call) => call.path.endsWith("/checkouts/prepare"));
    const pending = calls.some((call) => call.outcome === "pending");
    if (calls.length !== last) {
      last = calls.length;
      stableSince = Date.now();
    }
    if (asked && !pending && Date.now() - stableSince >= 300) return calls;
    if (Date.now() > deadline) return calls;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function mountWrapper(t, browser, wrapper) {
  const lab = await createLab({ prefix: PREFIX, noSwapProvider: true });
  lab.stack.addOrder(REFERENCE, 2100);
  const tab = await openTab(browser, lab);
  try {
    const script = lab.asset(`${wrapper.bundle}.js`, await wrapperBundle(wrapper.bundle));
    const server = wrapper.hydrate ? await vueServerHtml(PROPS) : "";
    await tab.page.goto(
      lab.page(
        documentHtml({
          body: `<div id="app">${server}</div>
<script type="module">
import "${script}";
await window.mountCheckout(${JSON.stringify(PROPS)}, ${JSON.stringify({ hydrate: wrapper.hydrate === true, strict: false })});
</script>`,
        }),
      ),
    );
    const calls = await quiet(tab);
    const checkout = tab.page.locator("openreceive-checkout");

    // 1. Every prop reached the element as its attribute.
    const carried = wrapper.ownRenderer
      ? undefined
      : await checkout.evaluate(
          (element, names) =>
            Object.fromEntries(names.map((name) => [name, element.getAttribute(name)])),
          Object.keys(EXPECTED.checkout.attributes),
        );
    await whileOpen(t, wrapper.known.attributes?.(), () => {
      if (carried === undefined) return;
      for (const [name, value] of Object.entries(EXPECTED.checkout.attributes)) {
        if (value === undefined) continue;
        assert.equal(
          carried[name],
          String(value),
          `${wrapper.name}: the element must carry ${name}="${value}" (${wrapper.who})`,
        );
      }
    });

    // 2. One prepare, under the prefix the shop mounted, and the checkout drew.
    const known = wrapper.known.prepare?.();
    await whileOpen(t, known, async () => {
      assert.deepEqual(
        calls
          .filter((call) => call.path.endsWith("/checkouts/prepare"))
          .map((call) => `${call.method} ${call.path} -> ${call.outcome}`),
        [`POST ${PREFIX}/checkouts/prepare -> 200`],
        `${wrapper.name}: the page must prepare the order once, under ${PREFIX}. Every fetch ` +
          `it made: ${JSON.stringify(calls)}`,
      );
      assert.deepEqual(
        calls.filter((call) => !call.path.startsWith(`${PREFIX}/`)),
        [],
        "no request may leave for a prefix the shop did not mount",
      );
      assert.deepEqual(tab.seen.failed, [], "the browser reported a request that never finished");
      assert.deepEqual(tab.seen.refused, [], "no request may be refused");
      const methods = wrapper.ownRenderer
        ? tab.page.getByRole("button", { name: /Bitcoin/ }).first()
        : checkout.locator(TILE);
      assert.equal(await methods.isVisible(), true, "the payment methods must show");
    });

    // 3. The framework had nothing to say. Vue reports a prop it could not set
    //    as a console warning, and only in a development build.
    await whileOpen(t, wrapper.known.console?.(), () => {
      assert.deepEqual(
        tab.seen.complaints.filter((line) => !line.includes("Failed to load resource")),
        [],
        `${wrapper.name}: nothing may reach the console as a warning or error`,
      );
    });
  } finally {
    await tab.close();
    await lab.close();
  }
}

// ----------------------------------------------- names that are also DOM properties

/**
 * Frameworks decide between `element.name = value` and
 * `setAttribute("name", value)` by asking `"name" in element` (Vue, Preact,
 * Lit, Solid; React for custom elements). An attribute that shares its name
 * with a DOM property is therefore set as that property, and a read-only one
 * (Element.prefix) drops the value without an error in a production build.
 * Asked of a real browser, because only a real browser has the properties.
 */
const COLLIDES_WITH_DOM = ["prefix"];

for (const engine of requestedEngines()) {
  test(`${engine}: only the known element attributes are also DOM properties`, async (t) => {
    const { browser, skip } = await launchEngine(engine);
    if (skip !== undefined) {
      t.skip(skip);
      return;
    }
    const lab = await createLab({ noSwapProvider: true });
    const tab = await openTab(browser, lab);
    try {
      await tab.page.goto(lab.page(documentHtml()));
      const names = [
        ...Object.values(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES),
        ...Object.values(OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES),
      ];
      const collisions = await tab.page.evaluate((attributeNames) => {
        const element = document.createElement("openreceive-checkout");
        const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return attributeNames.filter((name) => name in element || camel(name) in element);
      }, names);
      assert.deepEqual(
        [...new Set(collisions)].sort(),
        COLLIDES_WITH_DOM,
        "an element attribute shares its name with a DOM property. A framework that sets " +
          "properties will assign it there instead of writing the attribute. Rename the " +
          "attribute, or prove every wrapper still delivers it (the mounts below set it to a " +
          "non-default value) and add it to COLLIDES_WITH_DOM.",
      );
    } finally {
      await tab.close();
      await lab.close();
    }
  });

  test(`${engine}: every wrapper delivers non-default props and prepares once`, {
    concurrency: 4,
    timeout: 240_000,
  }, async (t) => {
    const { browser, skip } = await launchEngine(engine);
    if (skip !== undefined) {
      t.skip(skip);
      return;
    }
    await Promise.all(
      WRAPPERS.map((wrapper) => t.test(wrapper.name, (st) => mountWrapper(st, browser, wrapper))),
    );
  });
}

test("the Vue component renders on a server with no DOM", async () => {
  const html = await vueServerHtml(PROPS);
  assert.match(html, new RegExp(`<openreceive-checkout[^>]* reference="${REFERENCE}"`));
  assert.match(
    html,
    new RegExp(`<openreceive-checkout[^>]* prefix="${PREFIX}"`),
    "the server-rendered tag must carry the prefix: it is all a hydrated page has",
  );
});
