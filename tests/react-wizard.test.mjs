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
  OPENRECEIVE_PROVIDER_PREVIEW_LIMIT,
  applyCheckoutThemeAttributes,
  applyOpenReceiveThemeAttributes,
  createOpenReceivePaymentWizardModel,
  createOpenReceivePaymentWizardSelection,
  createOpenReceivePaymentWizardState,
  createOpenReceiveStoredThemeModel,
  createOpenReceiveThemeModel,
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  formatOpenReceiveCountdown,
  formatOpenReceiveDepositAmount,
  getOpenReceivePaymentMethodIcon,
  getOpenReceivePaymentStatusText,
  getCheckoutProviderIcon,
  getCheckoutProviderOpenLabel,
  getCheckoutProviderTutorials,
  getOpenReceiveRouteIcon,
  getOpenReceiveRouteNetworkLabel,
  getOpenReceiveNetworkIcon,
  getOpenReceiveSwapOptionIcon,
  getOpenReceiveWizardEmptyMessage,
  openReceiveCheckoutLabels,
  openReceivePaymentMethods,
  buildOpenReceiveMethodGridEntries,
  readOpenReceiveThemePreference,
  resolveOpenReceiveTheme,
  syncOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemePreference,
  updateOpenReceivePaymentWizardSelection,
  writeOpenReceiveThemePreference,
} from "@openreceive/browser/internal";
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
      orderUrl: false,
      checkout: {
        checkout_id: "or_chk_min",
        order_id: "order-min",
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
  const empty = buildOpenReceiveMethodGridEntries(openReceivePaymentMethods, []);
  assert.deepEqual(
    empty.map((entry) => (entry.kind === "method" ? entry.method.id : entry.group.label)),
    ["bitcoin"],
  );

  const withUsdt = buildOpenReceiveMethodGridEntries(openReceivePaymentMethods, [
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
  assert.match(html, /dark mode/);
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
  assert.match(html, /dark mode/);
  assert.match(html, /<section class="checkout">Checkout<\/section>/);
});

test("Browser checkout helpers own wizard state, storage, and theme behavior", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };

  assert.equal(formatOpenReceiveCountdown(65), "1:05");
  assert.equal(formatOpenReceiveDepositAmount("12.25900000"), "12.259");
  assert.equal(formatOpenReceiveDepositAmount("5.000"), "5");
  assert.equal(formatOpenReceiveDepositAmount("1.05"), "1.05");
  assert.equal(formatOpenReceiveDepositAmount("0.0008"), "0.0008");
  assert.equal(formatOpenReceiveDepositAmount("100"), "100");
  assert.equal(OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS, 3000);
  assert.equal(OPENRECEIVE_COPY_FEEDBACK_MS, 1800);
  assert.equal(OPENRECEIVE_PROVIDER_PREVIEW_LIMIT, 4);
  assert.equal(openReceiveCheckoutLabels.copyInvoice, "Copy invoice");
  assert.equal(openReceiveCheckoutLabels.bitcoinLightningInvoice, "Bitcoin Lightning invoice");
  assert.equal(getOpenReceivePaymentStatusText("settled").title, "Payment received");
  assert.equal(getOpenReceiveWizardEmptyMessage("bitcoin"), "Choose Bitcoin Lightning.");
  assert.equal(getCheckoutProviderOpenLabel("Boltz"), "How To Pay");
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
  assert.equal(getOpenReceiveRouteNetworkLabel("btc-lightning"), "Lightning Network");
  assert.equal(getOpenReceiveRouteNetworkLabel("usdt-tron"), "usdt-tron");
  assert.match(getOpenReceivePaymentMethodIcon("bitcoin"), /assets\/icons\/btc\.svg/);
  assert.match(
    getOpenReceiveRouteIcon({ symbol: "btc", route: "btc-lightning" }),
    /assets\/icons\/lightning\.svg/,
  );
  assert.match(
    getOpenReceiveRouteIcon({ symbol: "usdt", route: "usdt-tron" }),
    /assets\/icons\/usdt\.svg/,
  );
  assert.match(
    getOpenReceiveSwapOptionIcon({ label: "USDT", network_label: "Tron" }),
    /assets\/icons\/usdt\.svg/,
  );
  assert.match(
    getOpenReceiveSwapOptionIcon({ label: "USDC", network_label: "Solana" }),
    /assets\/icons\/usdc\.svg/,
  );
  assert.match(getOpenReceiveNetworkIcon("Tron"), /assets\/icons\/trx\.svg/);
  assert.match(getOpenReceiveNetworkIcon("Solana"), /assets\/icons\/sol\.svg/);
  assert.match(getOpenReceiveNetworkIcon("Ethereum"), /assets\/icons\/eth\.svg/);
  assert.equal(resolveOpenReceiveTheme("system", { systemDark: true }), "dark");
  assert.deepEqual(createOpenReceiveThemeModel("system", { systemDark: true }), {
    theme: "system",
    resolvedTheme: "dark",
    nextTheme: "light",
    toggleLabel: "dark mode",
    attributes: {
      "data-theme": "dark",
      "data-openreceive-theme": "dark",
    },
    checkoutElementAttributes: {
      theme: "dark",
    },
  });
  assert.equal(readOpenReceiveThemePreference({ storage, defaultTheme: "dark" }), "dark");
  assert.equal(readOpenReceiveThemePreference({ storage }), "system");
  writeOpenReceiveThemePreference("dark", { storage });
  assert.equal(readOpenReceiveThemePreference({ storage }), "dark");
  const storedThemeModel = createOpenReceiveStoredThemeModel({ storage });
  assert.deepEqual(storedThemeModel, {
    theme: "dark",
    resolvedTheme: "dark",
    nextTheme: "light",
    toggleLabel: "dark mode",
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
  applyOpenReceiveThemeAttributes(
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
  assert.equal(toggleOpenReceiveStoredThemePreference({ storage }).resolvedTheme, "light");
  assert.equal(readOpenReceiveThemePreference({ storage }), "light");
  const controlAttrs = {};
  const checkoutControlAttrs = {};
  const toggleControl = { textContent: "" };
  const controlTheme = syncOpenReceiveStoredThemeControls(
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
  assert.equal(toggleControl.textContent, "light mode");
  const toggledControlTheme = toggleOpenReceiveStoredThemeControls(
    {
      toggle: toggleControl,
    },
    { storage },
  );
  assert.equal(toggledControlTheme.resolvedTheme, "dark");
  assert.equal(toggleControl.textContent, "dark mode");

  const initialSelection = createOpenReceivePaymentWizardSelection();
  assert.equal(initialSelection.selectedMethod, null);
  assert.equal(initialSelection.selectedBitcoinRoute, null);

  const methodSelection = updateOpenReceivePaymentWizardSelection(initialSelection, {
    type: "select_method",
    method: "bitcoin",
  });
  assert.equal(methodSelection.selectedMethod, "bitcoin");
  assert.equal(methodSelection.selectedBitcoinRoute, "btc-lightning");

  const changedMethodSelection = updateOpenReceivePaymentWizardSelection(methodSelection, {
    type: "change_method",
  });
  assert.equal(changedMethodSelection.selectedMethod, null);
  assert.equal(changedMethodSelection.selectedBitcoinRoute, null);

  const bitcoinSelection = updateOpenReceivePaymentWizardSelection(changedMethodSelection, {
    type: "select_method",
    method: "bitcoin",
  });
  assert.equal(bitcoinSelection.selectedBitcoinRoute, "btc-lightning");
  const routeModel = createOpenReceivePaymentWizardModel(bitcoinSelection);
  assert.equal(routeModel.selectedRoute, "btc-lightning");
  assert.ok(routeModel.routeAssets.length > 0);
  const routeAssetDisplays = createOpenReceiveWizardRouteAssetDisplays(routeModel.routeAssets, {
    selectedRoute: routeModel.selectedRoute,
  });
  const lightningRouteAsset = routeAssetDisplays.find((asset) => asset.id === "btc-lightning");
  assert.equal(lightningRouteAsset?.selected, true);
  assert.equal(lightningRouteAsset?.subtitle, "Lightning Network");
  assert.match(lightningRouteAsset?.icon ?? "", /assets\/icons\/lightning\.svg/);

  const bitcoinState = createOpenReceivePaymentWizardState({
    selectedMethod: "bitcoin",
    selectedBitcoinRoute: "btc-lightning",
  });
  assert.equal(bitcoinState.selectedRouteId, "btc-lightning");
  assert.ok(bitcoinState.routes.length > 0);
  const bitcoinRouteDisplays = createOpenReceiveWizardRouteDisplays(bitcoinState.routes);
  assert.equal(bitcoinRouteDisplays[0].providers.length, bitcoinState.routes[0].providers.length);
  assert.equal(
    createOpenReceiveWizardRouteDisplays(bitcoinState.routes, {
      providerPreviewLimit: OPENRECEIVE_PROVIDER_PREVIEW_LIMIT,
    })[0].providers.length <= OPENRECEIVE_PROVIDER_PREVIEW_LIMIT,
    true,
  );
  assert.equal(
    bitcoinRouteDisplays[0].providers[0].copyLabel,
    openReceiveCheckoutLabels.copyInvoice,
  );
  assert.equal(bitcoinRouteDisplays[0].providers[0].copiedLabel, openReceiveCheckoutLabels.copied);
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
