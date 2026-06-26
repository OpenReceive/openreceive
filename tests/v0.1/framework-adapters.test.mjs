import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_STORAGE_KEY,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  createCheckoutElement,
  createCheckoutElementAttributes,
  createCheckoutElementListeners,
  createCheckoutShell,
  createCheckoutShellModel,
  createOpenReceiveThemeToggleElement,
  createOpenReceiveThemeToggleElementAttributes,
  createOpenReceiveThemeModel
} from "@openreceive/browser/internal";
import {
  createOpenReceiveAngularCheckoutBinding,
  createOpenReceiveAngularCheckoutComponentModel,
  createOpenReceiveAngularCheckoutController,
  createOpenReceiveAngularCheckoutShell,
  createOpenReceiveAngularCheckoutShellBinding,
  createOpenReceiveAngularStoredThemeBinding,
  createOpenReceiveAngularThemeBinding,
  createOpenReceiveAngularThemeToggleBinding,
  toggleOpenReceiveStoredThemeControls as toggleAngularThemeControls,
  toggleOpenReceiveStoredThemePreference as toggleAngularThemePreference
} from "@openreceive/angular";
import {
  applyCheckoutThemeAttributes as applySvelteCheckoutThemeAttributes,
  createOpenReceiveSvelteCheckoutBinding,
  createOpenReceiveSvelteCheckoutComponentModel,
  createOpenReceiveSvelteCheckoutController,
  createOpenReceiveSvelteCheckoutShell,
  createOpenReceiveSvelteCheckoutShellBinding,
  createOpenReceiveSvelteStoredThemeBinding,
  createOpenReceiveSvelteThemeBinding,
  createOpenReceiveSvelteThemeToggleBinding
} from "@openreceive/svelte";
import {
  applyOpenReceiveThemeAttributes as applyVueThemeAttributes,
  createOpenReceiveVueCheckoutBinding,
  createOpenReceiveVueCheckoutComponentModel,
  createOpenReceiveVueCheckoutController,
  createOpenReceiveVueCheckoutShell,
  createOpenReceiveVueCheckoutShellBinding,
  createOpenReceiveVueStoredThemeBinding,
  createOpenReceiveVueThemeBinding,
  createOpenReceiveVueThemeToggleBinding,
  syncOpenReceiveStoredThemeControls as syncVueThemeControls
} from "@openreceive/vue";

const snapshot = {
  invoice_id: "or_inv_test",
  invoice: "lnbc-test",
  payment_hash: "a".repeat(64),
  amount_msats: 200000,
  fiat_quote: {
    fiat: {
      currency: "USD",
      value: "0.05"
    }
  },
  transaction_state: "pending",
  workflow_state: "invoice_created",
  expires_at: 1999999999
};

test("browser owns custom-element checkout attributes and listeners", () => {
  const createdElements = [];
  const rootAttrs = {};
  const document = {
    createElement: (tagName) => {
      const attributes = {};
      const listeners = {};
      const element = {
        tagName,
        attributes,
        listeners,
        setAttribute: (name, value) => {
          attributes[name] = value;
        },
        addEventListener: (name, listener) => {
          listeners[name] = listener;
        }
      };
      createdElements.push(element);
      return element;
    }
  };
  const attributes = createCheckoutElementAttributes(snapshot, {
    lookupUrl: "/openreceive/v1/invoices/lookup",
    theme: "dark",
    paymentWizard: true
  });

  assert.deepEqual(attributes, {
    "invoice-id": "or_inv_test",
    invoice: "lnbc-test",
    "payment-hash": "a".repeat(64),
    "amount-msats": "200000",
    "fiat-currency": "USD",
    "fiat-value": "0.05",
    status: "pending",
    "expires-at": "1999999999",
    "lookup-url": "/openreceive/v1/invoices/lookup",
    theme: "dark",
    "payment-wizard": "true"
  });

  let copied = false;
  let receivedState = false;
  let receivedProviderCopy = false;
  const listeners = createCheckoutElementListeners({
    onCopy: () => {
      copied = true;
    },
    onState: () => {
      receivedState = true;
    },
    onProviderCopy: () => {
      receivedProviderCopy = true;
    }
  });
  listeners[OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy]?.(new Event("copy"));
  listeners[OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.state]?.(new Event("state"));
  listeners[OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.providerCopy]?.(new Event("provider-copy"));
  assert.equal(copied, true);
  assert.equal(receivedState, true);
  assert.equal(receivedProviderCopy, true);
  assert.equal(listeners[OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.error], undefined);

  const checkoutElement = createCheckoutElement(snapshot, {
    document,
    lookupUrl: "/openreceive/v1/invoices/lookup",
    theme: "dark",
    onError: () => undefined
  });
  assert.equal(checkoutElement.tagName, OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  assert.equal(checkoutElement.attributes["lookup-url"], "/openreceive/v1/invoices/lookup");
  assert.equal(checkoutElement.attributes.theme, "dark");
  assert.equal(typeof checkoutElement.listeners[OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.error], "function");
  assert.equal(createdElements.length, 1);

  const themeToggle = createOpenReceiveThemeToggleElement({
    document,
    rootSelector: ".page",
    checkoutSelector: "openreceive-checkout",
    defaultTheme: "light"
  });
  assert.equal(themeToggle.tagName, OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME);
  assert.equal(themeToggle.attributes["root-selector"], ".page");
  assert.equal(themeToggle.attributes["checkout-selector"], "openreceive-checkout");
  assert.equal(themeToggle.attributes["default-theme"], "light");

  const shell = createCheckoutShell(snapshot, {
    document,
    root: {
      setAttribute: (name, value) => {
        rootAttrs[name] = value;
      }
    },
    lookupUrl: "/openreceive/v1/invoices/lookup",
    rootSelector: ".page",
    defaultTheme: "light"
  });
  assert.equal(shell.checkout.tagName, OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  assert.equal(shell.checkout.attributes.theme, shell.theme.resolvedTheme);
  assert.equal(shell.themeToggle.tagName, OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME);
  assert.equal(shell.themeToggle.attributes["checkout-selector"], OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  assert.equal(rootAttrs["data-openreceive-theme"], shell.theme.resolvedTheme);

  assert.throws(
    () =>
      createCheckoutElementAttributes({
        invoice_id: "or_inv_bad",
        invoice: `nostr+walletconnect://${"a".repeat(64)}?secret=${"b".repeat(64)}`
      }),
    /must not be an NWC/
  );
});

test("browser owns custom-element theme-toggle attributes", () => {
  assert.deepEqual(createOpenReceiveThemeToggleElementAttributes({
    rootSelector: ".page",
    checkoutSelector: "openreceive-checkout",
    defaultTheme: "light",
    storageKey: "demo.theme"
  }), {
    "root-selector": ".page",
    "checkout-selector": "openreceive-checkout",
    "default-theme": "light",
    "storage-key": "demo.theme"
  });
  assert.equal(OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME, "openreceive-theme-toggle");
});

test("browser owns full checkout shell binding model", () => {
  const themeStore = new Map([[OPENRECEIVE_THEME_STORAGE_KEY, "dark"]]);
  const storage = {
    getItem: (key) => themeStore.get(key) ?? null,
    setItem: (key, value) => themeStore.set(key, value),
    removeItem: (key) => themeStore.delete(key),
    clear: () => themeStore.clear(),
    key: (index) => [...themeStore.keys()][index] ?? null,
    get length() {
      return themeStore.size;
    }
  };
  let copied = false;
  const shell = createCheckoutShellModel(snapshot, {
    lookupUrl: "/openreceive/v1/invoices/lookup",
    rootSelector: ".page",
    defaultTheme: "light",
    storage,
    onCopy: () => {
      copied = true;
    }
  });

  assert.equal(shell.theme.resolvedTheme, "dark");
  assert.equal(shell.rootAttributes["data-openreceive-theme"], "dark");
  assert.equal(shell.checkout.tagName, OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  assert.equal(shell.checkout.attributes.theme, "dark");
  assert.equal(shell.checkout.attributes["lookup-url"], "/openreceive/v1/invoices/lookup");
  assert.equal(typeof shell.checkout.listeners[OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy], "function");
  shell.checkout.listeners[OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy]?.(new Event("copy"));
  assert.equal(copied, true);
  assert.deepEqual(shell.themeToggle, {
    tagName: OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
    attributes: {
      "root-selector": ".page",
      "checkout-selector": OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
      "default-theme": "light"
    }
  });
});

test("browser owns shared theme binding state", () => {
  const light = createOpenReceiveThemeModel("system", { systemDark: false });
  assert.deepEqual(light, {
    theme: "system",
    resolvedTheme: "light",
    nextTheme: "dark",
    toggleLabel: "light mode",
    attributes: {
      "data-theme": "light",
      "data-openreceive-theme": "light"
    },
    checkoutElementAttributes: {
      theme: "light"
    }
  });

  const dark = createOpenReceiveThemeModel("dark");
  assert.equal(dark.resolvedTheme, "dark");
  assert.equal(dark.nextTheme, "light");
  assert.equal(dark.toggleLabel, "dark mode");
});

test("Vue, Svelte, and Angular adapters expose thin custom-element bindings", () => {
  const themeStore = new Map();
  const storage = {
    getItem: (key) => themeStore.get(key) ?? null,
    setItem: (key, value) => themeStore.set(key, value),
    removeItem: (key) => themeStore.delete(key),
    clear: () => themeStore.clear(),
    key: (index) => [...themeStore.keys()][index] ?? null,
    get length() {
      return themeStore.size;
    }
  };
  storage.setItem(OPENRECEIVE_THEME_STORAGE_KEY, "dark");

  const vue = createOpenReceiveVueCheckoutBinding(snapshot, {
    lookupUrl: "/openreceive/v1/invoices/lookup",
    theme: "light"
  });
  assert.equal(vue.tagName, OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  assert.equal(vue.attrs["lookup-url"], "/openreceive/v1/invoices/lookup");
  assert.equal(vue.attrs.theme, "light");

  const svelte = createOpenReceiveSvelteCheckoutBinding(snapshot, {
    paymentWizard: false
  });
  assert.equal(svelte.tagName, OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  assert.equal(svelte.props["payment-wizard"], "false");

  const angular = createOpenReceiveAngularCheckoutBinding(snapshot, {
    onError: () => undefined
  });
  assert.equal(angular.selector, OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  assert.equal(angular.attributes.invoice, "lnbc-test");
  assert.equal(typeof angular.events[OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.error], "function");

  assert.equal(createOpenReceiveVueThemeBinding("dark").toggleLabel, "dark mode");
  assert.equal(createOpenReceiveSvelteThemeBinding("system", { systemDark: false }).nextTheme, "dark");
  assert.deepEqual(createOpenReceiveAngularThemeBinding("light").checkoutElementAttributes, {
    theme: "light"
  });
  assert.deepEqual(createOpenReceiveVueThemeToggleBinding({
    rootSelector: ".page",
    checkoutSelector: "openreceive-checkout",
    defaultTheme: "light"
  }), {
    tagName: OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
    attrs: {
      "root-selector": ".page",
      "checkout-selector": "openreceive-checkout",
      "default-theme": "light"
    }
  });
  assert.equal(createOpenReceiveSvelteThemeToggleBinding().tagName, OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME);
  assert.equal(createOpenReceiveAngularThemeToggleBinding().selector, OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME);
  assert.equal(createOpenReceiveVueStoredThemeBinding({ storage }).resolvedTheme, "dark");
  assert.equal(createOpenReceiveSvelteStoredThemeBinding({ storage }).toggleLabel, "dark mode");
  assert.deepEqual(createOpenReceiveAngularStoredThemeBinding({ storage }).checkoutElementAttributes, {
    theme: "dark"
  });

  const vueShell = createOpenReceiveVueCheckoutShellBinding(snapshot, {
    lookupUrl: "/openreceive/v1/invoices/lookup",
    rootSelector: ".page",
    storage
  });
  assert.equal(vueShell.rootAttrs["data-theme"], "dark");
  assert.equal(vueShell.checkout.attrs.theme, "dark");
  assert.equal(vueShell.checkout.attrs["lookup-url"], "/openreceive/v1/invoices/lookup");
  assert.equal(vueShell.themeToggle.attrs["checkout-selector"], OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);

  const svelteShell = createOpenReceiveSvelteCheckoutShellBinding(snapshot, {
    paymentWizard: false,
    storage
  });
  assert.equal(svelteShell.rootProps["data-openreceive-theme"], "dark");
  assert.equal(svelteShell.checkout.props.theme, "dark");
  assert.equal(svelteShell.checkout.props["payment-wizard"], "false");
  assert.equal(svelteShell.themeToggle.props["checkout-selector"], OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);

  const angularShell = createOpenReceiveAngularCheckoutShellBinding(snapshot, {
    checkoutSelector: "#checkout",
    storage
  });
  assert.equal(angularShell.rootAttributes["data-theme"], "dark");
  assert.equal(angularShell.checkout.attributes.theme, "dark");
  assert.equal(angularShell.themeToggle.attributes["checkout-selector"], "#checkout");

  let vueSettled = false;
  const vueComponent = createOpenReceiveVueCheckoutComponentModel({
    invoice: snapshot,
    status: "pending",
    providers: [],
    theme: "light",
    lookupUrl: "/openreceive/v1/invoices/lookup",
    onSettled: () => {
      vueSettled = true;
    },
    defineElementsOptions: {}
  });
  assert.equal(vueComponent.componentName, "Checkout");
  assert.equal(typeof vueComponent.defineElements, "function");
  assert.equal(vueComponent.checkout.attrs["lookup-url"], "/openreceive/v1/invoices/lookup");
  assert.equal(vueComponent.checkout.attrs.theme, "light");
  vueComponent.checkout.listeners[OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled]?.(new Event("settled"));
  assert.equal(vueSettled, true);
  assert.equal(vueComponent.themeToggle.tagName, OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME);

  const svelteComponent = createOpenReceiveSvelteCheckoutComponentModel({
    invoice: snapshot,
    paymentWizard: false
  });
  assert.equal(svelteComponent.componentName, "Checkout");
  assert.equal(typeof svelteComponent.defineElements, "function");
  assert.equal(svelteComponent.checkout.props["payment-wizard"], "false");

  const angularComponent = createOpenReceiveAngularCheckoutComponentModel({
    invoice: snapshot,
    checkoutSelector: "#checkout"
  });
  assert.equal(angularComponent.componentName, "Checkout");
  assert.equal(typeof angularComponent.defineElements, "function");
  assert.equal(angularComponent.themeToggle.attributes["checkout-selector"], "#checkout");

  const vueController = createOpenReceiveVueCheckoutController({ snapshot });
  const svelteController = createOpenReceiveSvelteCheckoutController({ snapshot });
  const angularController = createOpenReceiveAngularCheckoutController({ snapshot });
  assert.equal(vueController.start().invoice_id, snapshot.invoice_id);
  assert.equal(svelteController.start().invoice, snapshot.invoice);
  assert.equal(angularController.start().payment_hash, snapshot.payment_hash);
  assert.equal(typeof vueController.reloadState, "function");
  assert.equal(typeof svelteController.retry, "function");
  assert.equal(typeof vueController.refreshExpiredInvoice, "function");
  assert.equal(typeof angularController.cancel, "function");
  vueController.stop();
  svelteController.stop();
  angularController.stop();

  const themeAttrs = {};
  const checkoutAttrs = {};
  applyVueThemeAttributes({
    setAttribute: (name, value) => {
      themeAttrs[name] = value;
    }
  }, createOpenReceiveVueStoredThemeBinding({ storage }));
  applySvelteCheckoutThemeAttributes({
    setAttribute: (name, value) => {
      checkoutAttrs[name] = value;
    }
  }, createOpenReceiveSvelteStoredThemeBinding({ storage }));
  assert.equal(themeAttrs["data-openreceive-theme"], "dark");
  assert.equal(checkoutAttrs.theme, "dark");
  assert.equal(toggleAngularThemePreference({ storage }).resolvedTheme, "light");
  const toggleTarget = { textContent: "" };
  assert.equal(syncVueThemeControls({ toggle: toggleTarget }, { storage }).resolvedTheme, "light");
  assert.equal(toggleTarget.textContent, "light mode");
  assert.equal(toggleAngularThemeControls({ toggle: toggleTarget }, { storage }).resolvedTheme, "dark");
  assert.equal(toggleTarget.textContent, "dark mode");
});

test("Vue, Svelte, and Angular adapters expose full checkout shell creators", () => {
  const createdElements = [];
  const createDocument = () => ({
    createElement: (tagName) => {
      const attributes = {};
      const listeners = {};
      const element = {
        tagName,
        attributes,
        listeners,
        setAttribute: (name, value) => {
          attributes[name] = value;
        },
        addEventListener: (name, listener) => {
          listeners[name] = listener;
        }
      };
      createdElements.push(element);
      return element;
    }
  });

  const vue = createOpenReceiveVueCheckoutShell(snapshot, {
    document: createDocument(),
    lookupUrl: "/openreceive/v1/invoices/lookup",
    defaultTheme: "light"
  });
  assert.equal(vue.checkout.tagName, OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  assert.equal(vue.checkout.attributes["lookup-url"], "/openreceive/v1/invoices/lookup");
  assert.equal(vue.themeToggle.tagName, OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME);

  const svelte = createOpenReceiveSvelteCheckoutShell(snapshot, {
    document: createDocument(),
    paymentWizard: false,
    defaultTheme: "dark"
  });
  assert.equal(svelte.checkout.attributes["payment-wizard"], "false");
  assert.equal(svelte.checkout.attributes.theme, "dark");

  const angular = createOpenReceiveAngularCheckoutShell(snapshot, {
    document: createDocument(),
    checkoutSelector: "#checkout",
    rootSelector: ".page"
  });
  assert.equal(angular.themeToggle.attributes["checkout-selector"], "#checkout");
  assert.equal(angular.themeToggle.attributes["root-selector"], ".page");
  assert.equal(createdElements.length, 6);
});

test("Vue, Svelte, and Angular packages ship component entry files", () => {
  const browserManifest = JSON.parse(readFileSync(
    path.join(process.cwd(), "packages/js/browser/package.json"),
    "utf8"
  ));
  const browserStylesPath = path.join(process.cwd(), "packages/js/browser/src/styles.css");
  assert.equal(browserManifest.exports["./styles.css"], "./dist/styles.css");
  assert.equal(browserManifest.exports["./country-map"].import, "./dist/country-map.js");
  assert.equal(existsSync(browserStylesPath), true, "browser shared styles exist");
  assert.match(readFileSync(browserStylesPath, "utf8"), /\[data-openreceive-checkout\]/);

  const packages = [
    {
      manifestPath: "packages/js/vue/package.json",
      exportName: "./checkout.vue",
      componentPath: "packages/js/vue/src/Checkout.vue",
      shellHelper: "createOpenReceiveVueCheckoutShellBinding",
      peerDependency: "vue"
    },
    {
      manifestPath: "packages/js/svelte/package.json",
      exportName: "./checkout.svelte",
      componentPath: "packages/js/svelte/src/Checkout.svelte",
      shellHelper: "createOpenReceiveSvelteCheckoutShellBinding",
      peerDependency: "svelte"
    },
    {
      manifestPath: "packages/js/angular/package.json",
      exportName: "./checkout-component",
      componentPath: "packages/js/angular/src/openreceive-checkout.component.mjs",
      shellHelper: "createOpenReceiveAngularCheckoutShellBinding",
      peerDependency: "@angular/core"
    }
  ];

  for (const item of packages) {
    const manifest = JSON.parse(readFileSync(
      path.join(process.cwd(), item.manifestPath),
      "utf8"
    ));
    const componentPath = path.join(process.cwd(), item.componentPath);
    const source = readFileSync(componentPath, "utf8");

    assert.equal(existsSync(componentPath), true, `${item.componentPath}: exists`);
    assert.equal(manifest.exports[item.exportName], `./dist/${path.basename(item.componentPath)}`);
    assert.equal(manifest.exports["./styles.css"], "./dist/styles.css");
    assert.equal(typeof manifest.peerDependencies[item.peerDependency], "string");
    assert.equal(manifest.peerDependenciesMeta[item.peerDependency].optional, true);
    assert.match(
      readFileSync(path.join(process.cwd(), path.dirname(item.componentPath), "styles.css"), "utf8"),
      /@openreceive\/browser\/styles\.css/,
      `${item.manifestPath}: styles export delegates to browser styles`
    );
    assert.match(source, new RegExp(item.shellHelper),
      `${item.componentPath}: delegates to shared shell binding`);
    assert.match(source, /defineOpenReceiveElements/,
      `${item.componentPath}: registers shared custom elements`);
    assert.doesNotMatch(source, /nostr\+walletconnect/,
      `${item.componentPath}: must not contain receive-only NWC codes`);
  }
});

test("frontend checkout guide shows Angular helpers in the Angular section", () => {
  const guide = readFileSync(
    path.join(process.cwd(), "docs/guides/frontend-checkout.md"),
    "utf8"
  );
  const angularSection = guide.slice(guide.indexOf("## Angular"), guide.indexOf("## Styling"));

  assert.match(angularSection, /@openreceive\/angular/);
  assert.match(angularSection, /createOpenReceiveAngularCheckoutShellBinding/);
  assert.doesNotMatch(angularSection, /@openreceive\/vue/);
  assert.doesNotMatch(angularSection, /createOpenReceiveVueCheckoutShellBinding/);
});
