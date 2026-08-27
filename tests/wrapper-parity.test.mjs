// docs/internal/wrapper-parity.md is the conformance table for the four wrappers.
// This asserts the shipped source matches it: same prop names, same defaults, same
// event surface. The drift it exists to catch (themeSwitcher vs themeToggle with
// opposite defaults, two of six handlers promoted to props) was invisible to every
// other test because no test ever compared the wrappers to each other.
//
// Since G7 the prop names live in ONE declaration
// (packages/js/browser/src/internal/checkout-props.ts). React and Vue derive from
// it, so for them this file guards the derivation; Svelte and Angular cannot
// derive it, so for them it still guards a hand-written list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createWrapperCheckoutShellBinding,
  validateCheckoutProps,
} from "../packages/js/elements/src/wrapper-shared.ts";
import {
  checkoutLabels,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_DEFAULT_PREFIX,
} from "../packages/js/browser/src/headless.ts";
import { checkoutRoutes } from "../packages/js/browser/src/internal/checkout.ts";
import { createSwapUnavailableModel } from "../packages/js/browser/src/internal/wizard.ts";
import { renderPaymentWizardHtml } from "../packages/js/elements/src/render-wizard.ts";
import { Checkout } from "../packages/js/react/src/index.ts";

const PARITY_DOC = "docs/internal/wrapper-parity.md";
const REACT_COMPONENT = "packages/js/react/src/checkout.ts";
// The one declaration of the shared prop surface (G7). React and Vue derive
// their props from it; Svelte and Angular restate the names because their prop
// syntax is a declaration, not a type.
const SHARED_PROPS_SOURCE = "packages/js/browser/src/internal/checkout-props.ts";
const SOURCES = {
  react: "packages/js/react/src/types.ts",
  vue: "packages/js/vue/src/Checkout.vue",
  svelte: "packages/js/svelte/src/Checkout.svelte",
  angular: "packages/js/angular/src/openreceive-checkout.component.ts",
};
const HANDLERS = [
  "onCopy",
  "onOpenWallet",
  "onState",
  "onSettled",
  "onProviderCopy",
  "onStartOver",
  "onError",
];
const SHARED_PROPS = [
  "checkout",
  "reference",
  "prefix",
  "paymentWizard",
  "decodeLinkUrl",
  "assetBaseUrl",
  "themeToggle",
  "defaultTheme",
  "storageKey",
  "metadata",
  "syncUrl",
  "resumePathPrefix",
  "routeReference",
  "resumable",
];

function read(file) {
  return readFileSync(file, "utf8");
}

/** The named declaration's own text, so a prop on a neighbouring interface never counts. */
function declaration(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${header} is not closed`);
  return source.slice(start, end);
}

test("the shared prop surface declares every prop in the parity table", () => {
  const doc = read(PARITY_DOC);
  const shared = read(SHARED_PROPS_SOURCE);
  for (const prop of SHARED_PROPS) {
    assert.match(doc, new RegExp(`\`${prop}\``), `${prop} is missing from ${PARITY_DOC}`);
    assert.match(
      shared,
      new RegExp(`readonly ${prop}\\?:`),
      `${prop} is missing from ${SHARED_PROPS_SOURCE}`,
    );
  }
});

test("React and Vue derive the prop surface instead of restating it", () => {
  // Two of the four copies this file used to police are gone: React's CheckoutProps
  // extends the shared type, and Vue's defineProps IS the shared type. A shared prop
  // re-declared in either is drift waiting to happen, so assert none comes back.
  const reactProps = declaration(read(SOURCES.react), "export interface CheckoutProps");
  assert.match(reactProps, /extends CheckoutComponentProps/);
  for (const prop of SHARED_PROPS) {
    assert.doesNotMatch(reactProps, new RegExp(`readonly ${prop}\\?:`), `React restates ${prop}`);
  }

  const vue = read(SOURCES.vue);
  assert.match(vue, /defineProps<WrapperCheckoutComponentProps>\(\)/);
  assert.doesNotMatch(vue, /defineProps<\{/, "Vue restates the prop surface inline");
});

test("Svelte and Angular restate the props, because their prop syntax cannot derive them", () => {
  // `export let` and `@Input()` are declarations, not types: nothing can spread
  // WrapperCheckoutComponentProps into either. The duplication is forced
  // (docs/internal/wrapper-parity.md says so, and both sources say why); this is
  // what keeps it in step.
  for (const [name, file] of Object.entries({ svelte: SOURCES.svelte, angular: SOURCES.angular })) {
    const source = read(file);
    for (const prop of SHARED_PROPS) {
      assert.match(
        source,
        new RegExp(`(export let|@Input\\(\\)) ${prop}[?:]`),
        `${name} is missing ${prop}`,
      );
    }
  }
});

test("the renamed theme props exist under one name across the wrappers", () => {
  for (const [name, file] of Object.entries(SOURCES)) {
    const source = read(file);
    assert.doesNotMatch(source, /themeSwitcher/, `${name} still uses the old themeSwitcher name`);
    assert.doesNotMatch(
      source,
      /themeStorageKey/,
      `${name} still uses the old themeStorageKey name`,
    );
  }
  assert.doesNotMatch(read(REACT_COMPONENT), /themeSwitcher|themeStorageKey/);
  // Canonical default: the checkout owns its theme unless the host opts out —
  // through the prop or through the `options` escape hatch. The element wrappers
  // used to spread a `true` prop default after `...options`, silently clobbering
  // an options-supplied `themeToggle: false`.
  assert.match(read(REACT_COMPONENT), /themeToggle = true/);
  assert.match(
    read(SOURCES.svelte),
    /themeToggle: themeToggle \?\? options\.themeToggle \?\? true/,
  );
  assert.match(
    read(SOURCES.angular),
    /themeToggle: this\.themeToggle \?\? this\.options\.themeToggle \?\? true/,
  );
  assert.match(
    read(SOURCES.vue),
    /themeToggle: props\.themeToggle \?\? props\.options\.themeToggle \?\? true/,
  );
});

test("every wrapper exposes all seven event handlers as first-class props", () => {
  for (const handler of HANDLERS) {
    for (const [name, file] of Object.entries(SOURCES)) {
      assert.match(
        read(file),
        new RegExp(`\\b${handler}\\b`),
        `${name} does not expose ${handler}`,
      );
    }
  }
});

test("the shared binding subscribes to every element event, including open-wallet", () => {
  const handlers = Object.fromEntries(HANDLERS.map((handler) => [handler, () => undefined]));
  const shell = createWrapperCheckoutShellBinding(null, {
    reference: "order-parity",
    ...handlers,
  });

  assert.deepEqual(
    Object.keys(shell.checkout.listeners).sort(),
    Object.values(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS).sort(),
    "the element dispatches events no wrapper option can subscribe to",
  );
});

test("missing mode props fail at the boundary with one clear error", () => {
  assert.throws(
    () => validateCheckoutProps({ framework: "@openreceive/test" }),
    /requires a checkout snapshot or a reference/,
  );
  // The shared factory used to be the first thing to notice, throwing from inside a
  // computed/reactive read (in Angular, once per change-detection pass).
  assert.throws(() => createWrapperCheckoutShellBinding(null, {}), TypeError);
});

test("create-mode props warn once per wrapper when passed in snapshot mode", () => {
  const snapshot = {
    checkout_id: "or_chk_parity",
    reference: "order-parity",
    status: "open",
    amount_msats: 1000,
    invoices: [],
  };
  const warnings = [];
  const props = {
    framework: "@openreceive/warn-once-probe",
    checkout: snapshot,
    syncUrl: true,
    warn: (message) => warnings.push(message),
  };

  validateCheckoutProps(props);
  validateCheckoutProps(props);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /syncUrl/);
  assert.match(warnings[0], /snapshot mode/);
});

test("React runs its mode props through the same boundary check as the wrappers", () => {
  // G6a: React used to carry its own CREATE_MODE_ONLY_PROPS list and its own warn
  // function. PRODUCT CHANGE — the missing-mode failure is now the shared TypeError
  // (it was a plain Error reading "<Checkout> requires ..."), and an empty-string
  // reference is rejected instead of quietly starting create mode with no order.
  assert.throws(
    () => Checkout({}),
    (error) =>
      error instanceof TypeError &&
      /@openreceive\/react Checkout requires a checkout snapshot or a reference/.test(
        error.message,
      ),
  );
  assert.throws(() => Checkout({ reference: "" }), TypeError);

  const snapshot = {
    checkout_id: "or_chk_react_boundary",
    reference: "order-react-boundary",
    status: "open",
    amount_msats: 1000,
    invoices: [],
  };
  const warnings = [];
  const realConsole = globalThis.console;
  globalThis.console = { ...realConsole, warn: (message) => warnings.push(message) };
  try {
    Checkout({ checkout: snapshot, syncUrl: true });
  } finally {
    globalThis.console = realConsole;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /@openreceive\/react Checkout ignores syncUrl in snapshot mode/);
});

test("React snapshot mode with no prefix polls via the default prefix", () => {
  // The element defaults `prefix` to /openreceive in snapshot mode, so a bare
  // <openreceive-checkout> polls out of the box. React used to derive its poll
  // URL only when the caller supplied a prefix — a bare <Checkout checkout={snapshot}>
  // rendered but never polled. The dispatcher is a plain function, so calling it
  // exposes the props it hands the snapshot-mode wrapper.
  const snapshot = {
    checkout_id: "or_chk_poll_parity",
    reference: "order-poll-parity",
    status: "open",
    amount_msats: 1000,
    invoices: [],
  };

  const bare = Checkout({ checkout: snapshot });
  assert.equal(bare.props.prefix, OPENRECEIVE_DEFAULT_PREFIX);

  const prefixed = Checkout({ checkout: snapshot, prefix: "/pay" });
  assert.equal(prefixed.props.prefix, "/pay");
});

test("snapshot-mode polling defaults and knobs match the parity table", () => {
  const doc = read(PARITY_DOC);
  // The documented default: a bare snapshot polls `${prefix}/payments/check`
  // with prefix `/openreceive` (docs/internal/wrapper-parity.md `prefix` row).
  assert.equal(OPENRECEIVE_DEFAULT_PREFIX, "/openreceive");
  assert.equal(
    checkoutRoutes(OPENRECEIVE_DEFAULT_PREFIX).paymentsCheck,
    "/openreceive/payments/check",
  );
  assert.match(doc, /`\/openreceive`/, "the parity table must pin the /openreceive default");

  const snapshot = {
    checkout_id: "or_chk_poll_defaults",
    reference: "order-poll-defaults",
    status: "open",
    amount_msats: 1000,
    invoices: [],
  };

  // The shared shell (vue/svelte/angular) emits no prefix attribute by default,
  // so the element resolves the same documented /openreceive default at poll
  // time (tests/wrapper-behavior.test.mjs proves that behaviorally through a
  // real mount; tests/element-lifecycle.test.mjs covers the element itself).
  const shell = createWrapperCheckoutShellBinding(snapshot, {});
  assert.equal(
    shell.checkout.attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix],
    undefined,
  );
  // `prefix` is the only URL attribute the element has (G5): there is no
  // per-route override to leak.
  assert.equal(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderUrl, undefined);

  // The polling knobs thread through shell options into the element attributes
  // the parity table names (`polling` / `pollIntervalMs`, wired via `options`
  // in the element wrappers, first-class props in React).
  const tuned = createWrapperCheckoutShellBinding(snapshot, {
    polling: false,
    pollIntervalMs: 1234,
  });
  assert.equal(tuned.checkout.attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.polling], "false");
  assert.equal(
    tuned.checkout.attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.pollIntervalMs],
    "1234",
  );
  assert.match(doc, /`polling` \/ `pollIntervalMs`/);
  assert.match(read(SOURCES.react), /\bpolling\?:/, "React must expose polling as a prop");
  assert.match(
    read(SOURCES.react),
    /\bpollIntervalMs\?:/,
    "React must expose pollIntervalMs as a prop",
  );
});

test("the theme is resolved from the default until the wrapper mounts", () => {
  const storage = {
    length: 1,
    clear: () => undefined,
    getItem: () => "dark",
    key: () => null,
    removeItem: () => undefined,
    setItem: () => undefined,
  };
  const deferred = createWrapperCheckoutShellBinding(null, {
    reference: "order-parity",
    deferThemeResolution: true,
  });
  const deferredWithHostStorage = createWrapperCheckoutShellBinding(null, {
    reference: "order-parity",
    storage,
    deferThemeResolution: true,
  });
  const mounted = createWrapperCheckoutShellBinding(null, {
    reference: "order-parity",
    storage,
  });

  assert.equal(deferred.rootAttributes["data-theme"], "light");
  // A host-supplied storage is read on the server too: that is the documented way
  // to server-render a chosen theme (docs/internal/wrapper-parity.md), and React
  // honors it. Only the implicit browser localStorage waits for mount.
  assert.equal(deferredWithHostStorage.rootAttributes["data-theme"], "dark");
  assert.equal(mounted.rootAttributes["data-theme"], "dark");

  for (const [name, file] of Object.entries({
    vue: SOURCES.vue,
    svelte: SOURCES.svelte,
    angular: SOURCES.angular,
  })) {
    assert.match(read(file), /deferThemeResolution/, `${name} resolves the theme before mount`);
  }
});

// C1/C6: the out-of-range swap pane is one model in @openreceive/browser. Both
// renderers must build it from that model, not from copy of their own — the
// drift this catches is real: React showed the accepted range and the element
// showed a generic swap-start error for the same amount.
test("both renderers build the unavailable swap pane from the shared model", () => {
  const quote = {
    pay_in_asset: "USDT_TRON",
    label: "USDT",
    network_label: "Tron",
    provider: "fixedfloat",
    available: false,
    unavailable_reason: "amount_too_small",
    minimum_pay_amount: "5.00",
    maximum_pay_amount: "5000.00",
  };
  const model = createSwapUnavailableModel(quote, undefined);
  assert.equal(model.title, "USDT unavailable");
  assert.equal(model.range, "Accepted range: 5.00–5000.00 USDT.");

  const elementHtml = renderPaymentWizardHtml({
    selectedSwapAsset: "USDT_TRON",
    swapOptions: [quote],
    unavailableSwapQuote: quote,
  });
  for (const line of [model.title, model.detail, model.range, model.hint]) {
    assert.ok(elementHtml.includes(line), `the element pane is missing "${line}"`);
  }

  // React's renderer reads the same model; assert it names the shared factory
  // rather than restating the copy.
  const reactSource = readFileSync("packages/js/react/src/swap.ts", "utf8");
  assert.match(reactSource, /createSwapUnavailableModel\(quote, checkout\)/);
  for (const literal of ["unavailable`", "Accepted range:", "Choose another asset above"]) {
    assert.ok(
      !reactSource.includes(literal),
      `React must not restate the unavailable-pane copy: ${literal}`,
    );
  }
});

// C6: the two renderers are deliberately separate implementations, but the
// payer-facing STRINGS are one declaration in @openreceive/browser. The drift
// this catches already happened: React's route swap buttons showed a hardcoded
// "Preparing..." while the element used checkoutLabels.preparingPayment.
test("both renderers read the shared payer-facing strings, not copies", () => {
  const SHARED_KEYS = [
    "swapStartFailedTitle",
    "tryAgain",
    "payWithLightningInstead",
    "supportReviewNeeded",
    "preparingPaymentAddress",
    "preparingPaymentAddressDetail",
    "createPaymentAddress",
    "paymentBreakdown",
    "cartTotal",
    "youSend",
    "swapAndNetworkFees",
    "refundAddressPlaceholder",
    "reviewRefundAddress",
    "confirmRefund",
    "confirmRefundTo",
    "tutorialBack",
    "tutorialNext",
    "tutorialClose",
  ];
  const reactSource = [
    "packages/js/react/src/swap.ts",
    "packages/js/react/src/wizard.ts",
    "packages/js/react/src/provider-tutorial.ts",
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const elementSource = [
    "packages/js/elements/src/render-swap-panel.ts",
    "packages/js/elements/src/render-wizard.ts",
    "packages/js/elements/src/render-provider-tutorial.ts",
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  for (const key of SHARED_KEYS) {
    assert.ok(checkoutLabels[key] !== undefined, `checkoutLabels is missing the shared key ${key}`);
    assert.ok(
      reactSource.includes(`checkoutLabels.${key}`),
      `React must read checkoutLabels.${key} instead of restating it`,
    );
    assert.ok(
      elementSource.includes(`checkoutLabels.${key}`),
      `the element must read checkoutLabels.${key} instead of restating it`,
    );
    // And neither renderer may keep the literal alongside the label.
    const literal = checkoutLabels[key];
    if (!literal.includes("{")) {
      for (const [name, source] of [
        ["React", reactSource],
        ["the element", elementSource],
      ]) {
        assert.ok(
          !source.includes(`"${literal}"`) && !source.includes(`>${literal}<`),
          `${name} still restates the literal for ${key}: ${literal}`,
        );
      }
    }
  }
});
