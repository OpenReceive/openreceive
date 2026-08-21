// docs/internal/wrapper-parity.md is the conformance table for the four wrappers.
// This asserts the shipped source matches it: same prop names, same defaults, same
// event surface. The drift it exists to catch (themeSwitcher vs themeToggle with
// opposite defaults, two of six handlers promoted to props) was invisible to every
// other test because no test ever compared the wrappers to each other.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createOpenReceiveWrapperCheckoutShellBinding,
  validateOpenReceiveWrapperCheckoutProps,
} from "../packages/js/elements/src/wrapper-shared.ts";
import {
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_DEFAULT_PREFIX,
  resolveOrderUrlFromPrefix,
} from "../packages/js/browser/src/internal.ts";
import { Checkout } from "../packages/js/react/src/index.ts";

const PARITY_DOC = "docs/internal/wrapper-parity.md";
const REACT_COMPONENT = "packages/js/react/src/checkout.ts";
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
  "orderId",
  "prefix",
  "orderUrl",
  "paymentWizard",
  "decodeLinkUrl",
  "themeToggle",
  "defaultTheme",
  "storageKey",
  "metadata",
  "syncUrl",
  "resumePathPrefix",
  "routeOrderId",
];

function read(file) {
  return readFileSync(file, "utf8");
}

test("every wrapper declares the shared prop names from the parity table", () => {
  const doc = read(PARITY_DOC);
  for (const prop of SHARED_PROPS) {
    assert.match(doc, new RegExp(`\`${prop}\``), `${prop} is missing from ${PARITY_DOC}`);
    for (const [name, file] of Object.entries(SOURCES)) {
      assert.match(read(file), new RegExp(`\\b${prop}\\??[:? ]`), `${name} is missing ${prop}`);
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
  const shell = createOpenReceiveWrapperCheckoutShellBinding(null, {
    orderId: "order-parity",
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
    () => validateOpenReceiveWrapperCheckoutProps({ framework: "@openreceive/test" }),
    /requires a checkout snapshot or an orderId/,
  );
  // The shared factory used to be the first thing to notice, throwing from inside a
  // computed/reactive read (in Angular, once per change-detection pass).
  assert.throws(() => createOpenReceiveWrapperCheckoutShellBinding(null, {}), TypeError);
});

test("create-mode props warn once per wrapper when passed in snapshot mode", () => {
  const snapshot = {
    checkout_id: "or_chk_parity",
    order_id: "order-parity",
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

  validateOpenReceiveWrapperCheckoutProps(props);
  validateOpenReceiveWrapperCheckoutProps(props);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /syncUrl/);
  assert.match(warnings[0], /snapshot mode/);
});

test("React snapshot mode with no prefix polls via the default prefix", () => {
  // The element defaults `prefix` to /openreceive in snapshot mode, so a bare
  // <openreceive-checkout> polls out of the box. React used to derive `orderUrl`
  // only when the caller supplied a prefix — a bare <Checkout checkout={snapshot}>
  // rendered but never polled. The dispatcher is a plain function, so calling it
  // exposes the props it hands the snapshot-mode wrapper.
  const snapshot = {
    checkout_id: "or_chk_poll_parity",
    order_id: "order-poll-parity",
    status: "open",
    amount_msats: 1000,
    invoices: [],
  };

  const bare = Checkout({ checkout: snapshot });
  assert.equal(
    bare.props.orderUrl,
    resolveOrderUrlFromPrefix(OPENRECEIVE_DEFAULT_PREFIX, snapshot.order_id),
  );

  const prefixed = Checkout({ checkout: snapshot, prefix: "/pay" });
  assert.equal(prefixed.props.orderUrl, resolveOrderUrlFromPrefix("/pay", snapshot.order_id));

  const explicit = Checkout({ checkout: snapshot, orderUrl: "/custom/payments/check" });
  assert.equal(explicit.props.orderUrl, "/custom/payments/check");

  // `orderUrl: false` still disables polling entirely (docs/internal/wrapper-parity.md).
  const disabled = Checkout({ checkout: snapshot, orderUrl: false });
  assert.equal(disabled.props.orderUrl, false);
});

test("snapshot-mode polling defaults and knobs match the parity table", () => {
  const doc = read(PARITY_DOC);
  // The documented default: a bare snapshot polls `${prefix}/payments/check`
  // with prefix `/openreceive` (docs/internal/wrapper-parity.md `prefix` row).
  assert.equal(OPENRECEIVE_DEFAULT_PREFIX, "/openreceive");
  assert.equal(
    resolveOrderUrlFromPrefix(OPENRECEIVE_DEFAULT_PREFIX),
    "/openreceive/payments/check",
  );
  assert.match(doc, /`\/openreceive`/, "the parity table must pin the /openreceive default");

  const snapshot = {
    checkout_id: "or_chk_poll_defaults",
    order_id: "order-poll-defaults",
    status: "open",
    amount_msats: 1000,
    invoices: [],
  };

  // The shared shell (vue/svelte/angular) emits no prefix/order-url attributes
  // by default, so the element resolves the same documented /openreceive
  // default at poll time (tests/wrapper-behavior.test.mjs proves that
  // behaviorally through a real mount; tests/element-lifecycle.test.mjs covers
  // the element itself).
  const shell = createOpenReceiveWrapperCheckoutShellBinding(snapshot, {});
  assert.equal(
    shell.checkout.attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix],
    undefined,
  );
  assert.equal(
    shell.checkout.attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderUrl],
    undefined,
  );

  // The polling knobs thread through shell options into the element attributes
  // the parity table names (`polling` / `pollIntervalMs`, wired via `options`
  // in the element wrappers, first-class props in React).
  const tuned = createOpenReceiveWrapperCheckoutShellBinding(snapshot, {
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
  const deferred = createOpenReceiveWrapperCheckoutShellBinding(null, {
    orderId: "order-parity",
    deferThemeResolution: true,
  });
  const deferredWithHostStorage = createOpenReceiveWrapperCheckoutShellBinding(null, {
    orderId: "order-parity",
    storage,
    deferThemeResolution: true,
  });
  const mounted = createOpenReceiveWrapperCheckoutShellBinding(null, {
    orderId: "order-parity",
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
