import assert from "node:assert/strict";
import test from "node:test";

// Browser checkout now auto-attaches a console logger at INFO; these unit tests
// do not assert that output, so keep the runner quiet unless explicitly overridden.
process.env.LOG_LEVEL ??= "error";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OPENRECEIVE_COPY_FEEDBACK_MS,
  OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS,
  createPaymentWizardModel,
  createPaymentWizardSelection,
  createStoredThemeModel,
  createThemeModel,
  createWizardRouteAssetDisplays,
  createWizardRouteDisplays,
  formatDepositAmount,
  getPaymentMethodIcon,
  getRouteNetworkLabel,
  getNetworkIcon,
  getSwapOptionIcon,
  getWizardEmptyMessage,
  checkoutLabels,
  paymentMethods,
  buildMethodGridEntries,
  readThemePreference,
  syncStoredThemeControls,
  toggleStoredThemeControls,
  updatePaymentWizardSelection,
  writeThemePreference,
} from "@openreceive/browser/headless";
// Test-only: an engine seam no renderer imports, read from its source module.
import { applyCheckoutThemeAttributes } from "../packages/js/browser/src/internal/theme.ts";
// Test-only: an engine seam no renderer imports, read from its source module.
import { applyThemeAttributes } from "../packages/js/browser/src/internal/theme.ts";
// Test-only: an engine seam no renderer imports, read from its source module.
import { createPaymentWizardState } from "../packages/js/browser/src/internal/wizard.ts";
// Test-only: an engine seam no renderer imports, read from its source module.
import { getPaymentStatusText } from "../packages/js/browser/src/internal/wizard.ts";
// Test-only: an engine seam no renderer imports, read from its source module.
import { getCheckoutProviderIcon } from "../packages/js/browser/src/internal/wizard.ts";
// Test-only: an engine seam no renderer imports, read from its source module.
import { getCheckoutProviderOpenLabel } from "../packages/js/browser/src/internal/wizard.ts";
// Test-only: an engine seam no renderer imports, read from its source module.
import { getCheckoutProviderTutorials } from "../packages/js/browser/src/internal/wizard.ts";
// Test-only: an engine seam no renderer imports, read from its source module.
import { getRouteIcon } from "../packages/js/browser/src/internal/wizard.ts";
// Test-only: an engine seam no renderer imports, read from its source module.
import { resolveTheme } from "../packages/js/browser/src/internal/theme.ts";
// Test-only: an engine seam no renderer imports, read from its source module.
import { toggleStoredThemePreference } from "../packages/js/browser/src/internal/theme.ts";
// Test-only: an engine seam no renderer imports, read from its source module.
import { OPENRECEIVE_PROVIDER_PREVIEW_LIMIT } from "../packages/js/browser/src/internal/dom-contract.ts";
import { formatCountdown } from "../packages/js/browser/src/internal/checkout-format.ts";
import { getProvider } from "@openreceive/provider-data";
import { PaymentWizard, ThemeScope, ThemeToggle } from "@openreceive/react";

test("React payment wizard server-renders the package-owned first choices", () => {
  const html = renderToStaticMarkup(
    React.createElement(PaymentWizard, {
      invoice: "lnbc-test",
    }),
  );

  assert.match(html, /Pay this invoice/);
  assert.match(html, /Bitcoin/);
  assert.match(html, /Loading currencies/);
  assert.doesNotMatch(html, />Crypto</);
  assert.doesNotMatch(html, /Credit Card/);
  assert.doesNotMatch(html, /Bank Transfer/);
});

test("React payment wizard greys under-minimum swaps with rounded minimum amount notes", () => {
  const html = renderToStaticMarkup(
    React.createElement(PaymentWizard, {
      invoice: undefined,
      checkout: {
        checkout_id: "or_chk_min",
        reference: "order-min",
        status: "open",
        amount_msats: 3_000_000,
        fiat: { currency: "USD", value: "2.00" },
        invoices: [],
        payment_methods: [
          {
            pay_in_asset: "USDC_SOL",
            label: "USDC",
            network_label: "Solana",
            provider: "fixedfloat",
            available: false,
            unavailable_reason: "amount_too_small",
            minimum_invoice_amount_msats: 3_225_000,
            minimum_pay_amount: "2.15",
          },
          {
            pay_in_asset: "ETH_ETH",
            label: "ETH",
            network_label: "Ethereum",
            provider: "fixedfloat",
            available: false,
            unavailable_reason: "amount_too_small",
            minimum_invoice_amount_msats: 25_425_000,
            minimum_pay_amount: "0.01",
          },
          {
            pay_in_asset: "SOL_SOL",
            label: "SOL",
            network_label: "Solana",
            provider: "fixedfloat",
            available: true,
            minimum_invoice_amount_msats: 2_800_000,
          },
        ],
      },
    }),
  );

  assert.match(html, /Bitcoin/);
  assert.match(html, /USDC/);
  assert.match(html, /SOL/);
  assert.match(html, /ETH/);
  assert.match(html, /Minimum amount \$2\.15/);
  assert.match(html, /Minimum amount \$16\.95/);
  assert.doesNotMatch(html, /Minimum payment/);
  // Limit notes sit under the greyed tiles (sibling of the disabled button).
  assert.match(
    html,
    /aria-disabled="true"[\s\S]*?<\/button><span class="[^"]*text-base-content\/55[^"]*">Minimum amount/,
  );
});

test("method grid never includes the standalone Crypto button", () => {
  const empty = buildMethodGridEntries(paymentMethods, []);
  assert.deepEqual(
    empty.map((entry) => (entry.kind === "method" ? entry.method.id : entry.group.label)),
    ["bitcoin"],
  );

  const withUsdt = buildMethodGridEntries(paymentMethods, [
    {
      label: "USDT",
      pay_in_asset: "USDT_TRON",
      network_label: "Tron",
      provider: "fixedfloat",
      available: true,
    },
  ]);
  assert.deepEqual(
    withUsdt.map((entry) => (entry.kind === "method" ? entry.method.id : entry.group.label)),
    ["bitcoin", "USDT"],
  );
  assert.equal(
    withUsdt.some((entry) => entry.kind === "method" && entry.method.id === "crypto"),
    false,
  );
});

test("React theme toggle renders a package-owned light/dark switch", () => {
  const html = renderToStaticMarkup(
    React.createElement(ThemeToggle, {
      theme: "dark",
      resolvedTheme: "dark",
    }),
  );

  assert.match(html, /data-openreceive-theme-toggle/);
  assert.match(html, /switch to light mode/);
  assert.doesNotMatch(html, /or-theme-toggle-icon-dark/);
});

test("React theme scope applies package-owned theme attributes and toggle", () => {
  const storage = {
    getItem: () => "dark",
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  };
  const html = renderToStaticMarkup(
    React.createElement(
      ThemeScope,
      {
        as: "main",
        className: "app-shell",
        storage,
        themeToggle: true,
        topbarClassName: "topbar",
        themeToggleClassName: "theme-button",
      },
      React.createElement("section", { className: "checkout" }, "Checkout"),
    ),
  );

  assert.match(html, /<main class="app-shell" data-theme="dark" data-openreceive-theme="dark"/);
  assert.match(html, /class="topbar"/);
  assert.match(html, /class="[^"]*theme-button/);
  assert.match(html, /data-openreceive-theme-toggle/);
  assert.match(html, /switch to light mode/);
  assert.match(html, /<section class="checkout">Checkout<\/section>/);
});

/** In-memory Storage-shaped object shared by the theme/storage tests below. */
function createTestStorage() {
  const store = new Map();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

test("browser checkout formatting helpers and UI constants", () => {
  assert.equal(formatCountdown(65), "1:05");
  assert.equal(formatDepositAmount("12.25900000"), "12.259");
  assert.equal(formatDepositAmount("5.000"), "5");
  assert.equal(formatDepositAmount("1.05"), "1.05");
  assert.equal(formatDepositAmount("0.0008"), "0.0008");
  assert.equal(formatDepositAmount("100"), "100");
  assert.equal(OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS, 3000);
  assert.equal(OPENRECEIVE_COPY_FEEDBACK_MS, 1800);
  assert.equal(OPENRECEIVE_PROVIDER_PREVIEW_LIMIT, 4);
});

test("browser checkout labels and status text", () => {
  assert.equal(checkoutLabels.copyInvoice, "Copy invoice");
  assert.equal(checkoutLabels.bitcoinLightningInvoice, "Bitcoin Lightning invoice");
  assert.equal(getPaymentStatusText("settled").title, "Payment received");
  assert.equal(getWizardEmptyMessage("bitcoin"), "Choose Bitcoin Lightning.");
  assert.equal(getCheckoutProviderOpenLabel("Boltz"), "How To Pay");
});

test("browser checkout provider icon and tutorial helpers", () => {
  const strike = getProvider("strike");
  assert.ok(strike);
  assert.match(getCheckoutProviderIcon(strike), /assets\/provider-icons\/strike\.png/);
  assert.deepEqual(
    getCheckoutProviderTutorials(strike).map((tutorial) => tutorial.caption),
    ["Tap Send", "Choose Bitcoin wallet", "Tap Paste", "Confirm the payment"],
  );
  const coinbase = getProvider("coinbase");
  const kraken = getProvider("kraken");
  assert.ok(coinbase);
  assert.ok(kraken);
  assert.match(
    getCheckoutProviderTutorials(coinbase)[0].image,
    /assets\/pay_tutorials\/coinbase-1\.webp/,
  );
  assert.match(
    getCheckoutProviderTutorials(kraken)[3].image,
    /assets\/pay_tutorials\/kraken-4\.webp/,
  );
});

test("browser checkout route, method, and network icon helpers", () => {
  assert.equal(getRouteNetworkLabel("btc-lightning"), "Lightning Network");
  assert.equal(getRouteNetworkLabel("usdt-tron"), "usdt-tron");
  assert.match(getPaymentMethodIcon("bitcoin"), /assets\/icons\/btc\.svg/);
  assert.match(
    getRouteIcon({ symbol: "btc", route: "btc-lightning" }),
    /assets\/icons\/lightning\.svg/,
  );
  assert.match(getRouteIcon({ symbol: "usdt", route: "usdt-tron" }), /assets\/icons\/usdt\.svg/);
  assert.match(
    getSwapOptionIcon({ label: "USDT", network_label: "Tron" }),
    /assets\/icons\/usdt\.svg/,
  );
  assert.match(
    getSwapOptionIcon({ label: "USDC", network_label: "Solana" }),
    /assets\/icons\/usdc\.svg/,
  );
  assert.match(getNetworkIcon("Tron"), /assets\/icons\/trx\.svg/);
  assert.match(getNetworkIcon("Solana"), /assets\/icons\/sol\.svg/);
  assert.match(getNetworkIcon("Ethereum"), /assets\/icons\/eth\.svg/);
});

test("browser checkout theme resolution builds a full theme model", () => {
  assert.equal(resolveTheme("system", { systemDark: true }), "dark");
  assert.deepEqual(createThemeModel("system", { systemDark: true }), {
    theme: "system",
    resolvedTheme: "dark",
    nextTheme: "light",
    toggleLabel: "switch to light mode",
    attributes: {
      "data-theme": "dark",
      "data-openreceive-theme": "dark",
    },
    checkoutElementAttributes: {
      theme: "dark",
    },
  });
});

test("browser checkout theme preference round-trips through storage", () => {
  const storage = createTestStorage();
  assert.equal(readThemePreference({ storage, defaultTheme: "dark" }), "dark");
  assert.equal(readThemePreference({ storage }), "system");
  writeThemePreference("dark", { storage });
  assert.equal(readThemePreference({ storage }), "dark");
  const storedThemeModel = createStoredThemeModel({ storage });
  assert.deepEqual(storedThemeModel, {
    theme: "dark",
    resolvedTheme: "dark",
    nextTheme: "light",
    toggleLabel: "switch to light mode",
    attributes: {
      "data-theme": "dark",
      "data-openreceive-theme": "dark",
    },
    checkoutElementAttributes: {
      theme: "dark",
    },
  });
  const themeAttrs = {};
  const checkoutAttrs = {};
  applyThemeAttributes(
    {
      getAttribute: (name) => themeAttrs[name] ?? null,
      setAttribute: (name, value) => {
        themeAttrs[name] = value;
      },
    },
    storedThemeModel,
  );
  applyCheckoutThemeAttributes(
    {
      getAttribute: (name) => checkoutAttrs[name] ?? null,
      setAttribute: (name, value) => {
        checkoutAttrs[name] = value;
      },
    },
    storedThemeModel,
  );
  assert.deepEqual(themeAttrs, {
    "data-theme": "dark",
    "data-openreceive-theme": "dark",
  });
  assert.deepEqual(checkoutAttrs, {
    theme: "dark",
  });
  assert.equal(toggleStoredThemePreference({ storage }).resolvedTheme, "light");
  assert.equal(readThemePreference({ storage }), "light");
});

test("browser checkout stored theme controls sync and toggle together", () => {
  const storage = createTestStorage();
  writeThemePreference("light", { storage });
  const controlAttrs = {};
  const checkoutControlAttrs = {};
  const toggleControl = { textContent: "" };
  const controlTheme = syncStoredThemeControls(
    {
      root: {
        getAttribute: (name) => controlAttrs[name] ?? null,
        setAttribute: (name, value) => {
          controlAttrs[name] = value;
        },
      },
      checkout: {
        getAttribute: (name) => checkoutControlAttrs[name] ?? null,
        setAttribute: (name, value) => {
          checkoutControlAttrs[name] = value;
        },
      },
      toggle: toggleControl,
    },
    { storage },
  );
  assert.equal(controlTheme.resolvedTheme, "light");
  assert.equal(controlAttrs["data-openreceive-theme"], "light");
  assert.equal(checkoutControlAttrs.theme, "light");
  assert.equal(toggleControl.textContent, "switch to dark mode");
  const toggledControlTheme = toggleStoredThemeControls(
    {
      toggle: toggleControl,
    },
    { storage },
  );
  assert.equal(toggledControlTheme.resolvedTheme, "dark");
  assert.equal(toggleControl.textContent, "switch to light mode");
});

test("browser checkout wizard selection is a pure state machine", () => {
  const initialSelection = createPaymentWizardSelection();
  assert.equal(initialSelection.selectedMethod, null);
  assert.equal(initialSelection.selectedBitcoinRoute, null);

  const methodSelection = updatePaymentWizardSelection(initialSelection, {
    type: "select_method",
    method: "bitcoin",
  });
  assert.equal(methodSelection.selectedMethod, "bitcoin");
  assert.equal(methodSelection.selectedBitcoinRoute, "btc-lightning");

  const changedMethodSelection = updatePaymentWizardSelection(methodSelection, {
    type: "change_method",
  });
  assert.equal(changedMethodSelection.selectedMethod, null);
  assert.equal(changedMethodSelection.selectedBitcoinRoute, null);

  const bitcoinSelection = updatePaymentWizardSelection(changedMethodSelection, {
    type: "select_method",
    method: "bitcoin",
  });
  assert.equal(bitcoinSelection.selectedBitcoinRoute, "btc-lightning");
  const routeModel = createPaymentWizardModel(bitcoinSelection);
  assert.equal(routeModel.selectedRoute, "btc-lightning");
  assert.ok(routeModel.routeAssets.length > 0);
  const routeAssetDisplays = createWizardRouteAssetDisplays(routeModel.routeAssets, {
    selectedRoute: routeModel.selectedRoute,
  });
  const lightningRouteAsset = routeAssetDisplays.find((asset) => asset.id === "btc-lightning");
  assert.equal(lightningRouteAsset?.selected, true);
  assert.equal(lightningRouteAsset?.subtitle, "Lightning Network");
  assert.match(lightningRouteAsset?.icon ?? "", /assets\/icons\/lightning\.svg/);
});

test("browser checkout wizard route displays carry provider entries", () => {
  const bitcoinState = createPaymentWizardState({
    selectedMethod: "bitcoin",
    selectedBitcoinRoute: "btc-lightning",
  });
  assert.equal(bitcoinState.selectedRouteId, "btc-lightning");
  assert.ok(bitcoinState.routes.length > 0);
  const bitcoinRouteDisplays = createWizardRouteDisplays(bitcoinState.routes);
  assert.equal(bitcoinRouteDisplays[0].providers.length, bitcoinState.routes[0].providers.length);
  assert.equal(
    createWizardRouteDisplays(bitcoinState.routes, {
      providerPreviewLimit: OPENRECEIVE_PROVIDER_PREVIEW_LIMIT,
    })[0].providers.length <= OPENRECEIVE_PROVIDER_PREVIEW_LIMIT,
    true,
  );
  assert.equal(bitcoinRouteDisplays[0].providers[0].copyLabel, checkoutLabels.copyInvoice);
  assert.equal(bitcoinRouteDisplays[0].providers[0].copiedLabel, checkoutLabels.copied);
  assert.equal(bitcoinRouteDisplays[0].providers[0].openLabel, "How To Pay");
  assert.equal(bitcoinRouteDisplays[0].providers[0].kind, "browser wallet");
  assert.equal(
    bitcoinRouteDisplays[0].providers.find((provider) => provider.id === "zeus")?.kind,
    "mobile wallet",
  );
  const strikeProvider = bitcoinRouteDisplays[0].providers.find(
    (provider) => provider.id === "strike",
  );
  assert.ok(strikeProvider);
  assert.match(strikeProvider.url, /^https:\/\/docs\.strike\.me/);
  assert.match(strikeProvider.icon, /assets\/provider-icons\/strike\.png/);
  assert.equal(strikeProvider.tutorials.length, 4);
  assert.match(strikeProvider.tutorials[0].image, /assets\/pay_tutorials\/strike-1\.webp/);
});
