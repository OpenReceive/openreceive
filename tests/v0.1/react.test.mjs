import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OPENRECEIVE_COUNTRY_MAP_HEIGHT,
  OPENRECEIVE_COUNTRY_MAP_WIDTH,
  OPENRECEIVE_COPY_FEEDBACK_MS,
  OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS,
  OPENRECEIVE_INVOICE_EVENT_TYPES,
  OPENRECEIVE_PROVIDER_PREVIEW_LIMIT,
  applyOpenReceiveCheckoutThemeAttributes,
  applyOpenReceiveThemeAttributes,
  createOpenReceiveCountryPickerModel,
  createOpenReceivePaymentWizardModel,
  createOpenReceivePaymentWizardSelection,
  createOpenReceivePaymentWizardState,
  createOpenReceiveStoredThemeModel,
  createOpenReceiveThemeModel,
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  formatOpenReceiveCountdown,
  getOpenReceiveAltcoinAssets,
  getOpenReceivePaymentMethodIcon,
  getOpenReceivePaymentStatusText,
  getOpenReceiveProviderIcon,
  getOpenReceiveProviderOpenLabel,
  getOpenReceiveProviderUsBadge,
  getOpenReceiveRouteIcon,
  getOpenReceiveRouteNetworkLabel,
  getOpenReceiveRegionForCountry,
  getOpenReceiveWizardEmptyMessage,
  openReceiveCheckoutLabels,
  readOpenReceiveStoredCountryCode,
  readOpenReceiveThemePreference,
  resolveOpenReceiveTheme,
  syncOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemePreference,
  updateOpenReceivePaymentWizardSelection,
  writeOpenReceiveStoredCountryCode,
  writeOpenReceiveThemePreference
} from "@openreceive/browser";
import {
  getProvider,
} from "@openreceive/provider-data";
import {
  CopyInvoiceButton,
  InvoiceSummary,
  OpenReceiveCheckout,
  OpenReceiveCopyButton,
  OpenReceiveInvoiceSummary,
  OpenReceiveOpenWalletButton,
  OpenReceivePaymentWizard,
  OpenReceivePaymentState,
  OpenReceiveProvider,
  OpenReceiveThemeScope,
  OpenReceiveThemeToggle,
  OpenWalletButton,
  PaymentState,
  createOpenReceiveCheckoutViewModel,
  useOpenReceiveCheckoutContext
} from "@openreceive/react";

test("React checkout view model exposes display-safe actions", () => {
  const model = createOpenReceiveCheckoutViewModel({
    invoice: "lnbc-test",
    payment_hash: "a".repeat(64),
    amount_msats: 200000,
    fiat_quote: {
      fiat: {
        currency: "USD",
        value: "0.05"
      }
    },
    transaction_state: "pending"
  });

  assert.equal(model.lightningUri, "lightning:lnbc-test");
  assert.equal(model.amountLabel, "200 sats");
  assert.equal(model.fiatLabel, "$0.05");
  assert.equal(model.paymentHashLabel, "aaaaaaaa...aaaaaaaa");
  assert.equal(model.transactionStateLabel, "pending");
});

test("React checkout rejects NWC strings before rendering", () => {
  assert.throws(
    () =>
      createOpenReceiveCheckoutViewModel({
        invoice: `nostr+walletconnect://${"a".repeat(64)}?secret=${"b".repeat(64)}`
      }),
    /must not be an NWC/
  );
});

test("React checkout default UI server-renders display-safe invoice data", () => {
  const html = renderToStaticMarkup(
    React.createElement(OpenReceiveCheckout, {
      invoice: "lnbc-test",
      payment_hash: "b".repeat(64),
      amount_msats: 1000,
      transaction_state: "pending"
    })
  );

  assert.match(html, /data-openreceive-checkout/);
  assert.match(html, /data-openreceive-theme="light"/);
  assert.match(html, /1 sat/);
  assert.match(html, /pending/);
  assert.doesNotMatch(html, /bbbbbbbb\.\.\.bbbbbbbb/);
  assert.match(html, /Copy invoice/);
  assert.doesNotMatch(html, /Open Wallet/);
  assert.doesNotMatch(html, /nostr\+walletconnect/);
});

test("React checkout default UI includes countdown, waiting state, and payment wizard", () => {
  const now = Math.floor(Date.now() / 1000);
  const html = renderToStaticMarkup(
    React.createElement(OpenReceiveCheckout, {
      invoice_id: "or_inv_test",
      invoice: "lnbc-test",
      payment_hash: "b".repeat(64),
      amount_msats: 1000,
      transaction_state: "pending",
      workflow_state: "invoice_created",
      expires_at: now + 600
    })
  );

  assert.match(html, /Waiting for payment/);
  assert.match(html, /Invoice expires in/);
  assert.match(html, /Pay this invoice/);
  assert.match(html, /Credit Card/);
  assert.match(html, /Bank Transfer/);
  assert.match(html, /Bitcoin/);
  assert.match(html, /Crypto/);
  assert.doesNotMatch(html, /or_inv_test/);
});

test("React payment wizard server-renders the four package-owned first choices", () => {
  const html = renderToStaticMarkup(
    React.createElement(OpenReceivePaymentWizard, {
      invoice: "lnbc-test"
    })
  );

  assert.match(html, /Pay this invoice/);
  assert.match(html, /Credit Card/);
  assert.match(html, /Bank Transfer/);
  assert.match(html, /Bitcoin/);
  assert.match(html, /Crypto/);
});

test("React theme toggle renders a package-owned light/dark switch", () => {
  const html = renderToStaticMarkup(
    React.createElement(OpenReceiveThemeToggle, {
      theme: "dark",
      resolvedTheme: "dark"
    })
  );

  assert.match(html, /data-openreceive-theme-toggle/);
  assert.match(html, /Light mode/);
});

test("React theme scope applies package-owned theme attributes and toggle", () => {
  const storage = {
    getItem: () => "dark",
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0
  };
  const html = renderToStaticMarkup(
    React.createElement(
      OpenReceiveThemeScope,
      {
        as: "main",
        className: "app-shell",
        storage,
        themeToggle: true,
        topbarClassName: "topbar",
        themeToggleClassName: "theme-button"
      },
      React.createElement("section", { className: "checkout" }, "Checkout")
    )
  );

  assert.match(html, /<main class="app-shell" data-theme="dark" data-openreceive-theme="dark"/);
  assert.match(html, /class="topbar"/);
  assert.match(html, /class="theme-button"/);
  assert.match(html, /data-openreceive-theme-toggle/);
  assert.match(html, /Light mode/);
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
    }
  };

  assert.equal(formatOpenReceiveCountdown(65), "1:05");
  assert.equal(OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS, 3000);
  assert.equal(OPENRECEIVE_COPY_FEEDBACK_MS, 1800);
  assert.equal(OPENRECEIVE_PROVIDER_PREVIEW_LIMIT, 4);
  assert.deepEqual([...OPENRECEIVE_INVOICE_EVENT_TYPES], [
    "invoice.verifying",
    "invoice.settled",
    "invoice.expired",
    "invoice.failed",
    "invoice.settlement_action_completed"
  ]);
  assert.equal(openReceiveCheckoutLabels.copyInvoice, "Copy invoice");
  assert.equal(getOpenReceivePaymentStatusText("settled").title, "Payment received");
  assert.equal(getOpenReceiveWizardEmptyMessage("bitcoin"), "Choose Lightning or on-chain Bitcoin.");
  assert.equal(getOpenReceiveProviderOpenLabel("Boltz"), "How To Pay");
  assert.equal(getOpenReceiveProviderUsBadge(true), null);
  assert.equal(getOpenReceiveProviderUsBadge(null), null);
  const strike = getProvider("strike");
  assert.ok(strike);
  assert.match(getOpenReceiveProviderIcon(strike), /assets\/provider-icons\/strike\.png/);
  assert.equal(getOpenReceiveRouteNetworkLabel("btc-lightning"), "Lightning Network");
  assert.equal(getOpenReceiveRouteNetworkLabel("usdt-tron"), "usdt-tron");
  assert.match(getOpenReceivePaymentMethodIcon("card"), /assets\/icons\/card\.svg/);
  assert.match(getOpenReceiveRouteIcon({ symbol: "btc", route: "btc-lightning" }), /assets\/icons\/lightning\.svg/);
  assert.match(getOpenReceiveRouteIcon({ symbol: "usdt", route: "usdt-tron" }), /assets\/icons\/usdt\.svg/);
  assert.equal(resolveOpenReceiveTheme("system", { systemDark: true }), "dark");
  assert.deepEqual(createOpenReceiveThemeModel("system", { systemDark: true }), {
    theme: "system",
    resolvedTheme: "dark",
    nextTheme: "light",
    toggleLabel: "Light mode",
    attributes: {
      "data-theme": "dark",
      "data-openreceive-theme": "dark"
    },
    checkoutElementAttributes: {
      theme: "dark"
    }
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
    toggleLabel: "Light mode",
    attributes: {
      "data-theme": "dark",
      "data-openreceive-theme": "dark"
    },
    checkoutElementAttributes: {
      theme: "dark"
    }
  });
  const themeAttrs = {};
  const checkoutAttrs = {};
  applyOpenReceiveThemeAttributes({
    setAttribute: (name, value) => {
      themeAttrs[name] = value;
    }
  }, storedThemeModel);
  applyOpenReceiveCheckoutThemeAttributes({
    setAttribute: (name, value) => {
      checkoutAttrs[name] = value;
    }
  }, storedThemeModel);
  assert.deepEqual(themeAttrs, {
    "data-theme": "dark",
    "data-openreceive-theme": "dark"
  });
  assert.deepEqual(checkoutAttrs, {
    theme: "dark"
  });
  assert.equal(toggleOpenReceiveStoredThemePreference({ storage }).resolvedTheme, "light");
  assert.equal(readOpenReceiveThemePreference({ storage }), "light");
  const controlAttrs = {};
  const checkoutControlAttrs = {};
  const toggleControl = { textContent: "" };
  const controlTheme = syncOpenReceiveStoredThemeControls({
    root: {
      setAttribute: (name, value) => {
        controlAttrs[name] = value;
      }
    },
    checkout: {
      setAttribute: (name, value) => {
        checkoutControlAttrs[name] = value;
      }
    },
    toggle: toggleControl
  }, { storage });
  assert.equal(controlTheme.resolvedTheme, "light");
  assert.equal(controlAttrs["data-openreceive-theme"], "light");
  assert.equal(checkoutControlAttrs.theme, "light");
  assert.equal(toggleControl.textContent, "Dark mode");
  const toggledControlTheme = toggleOpenReceiveStoredThemeControls({
    toggle: toggleControl
  }, { storage });
  assert.equal(toggledControlTheme.resolvedTheme, "dark");
  assert.equal(toggleControl.textContent, "Light mode");
  writeOpenReceiveStoredCountryCode("us", { storage });
  assert.equal(readOpenReceiveStoredCountryCode({ storage }), "US");

  const initialSelection = createOpenReceivePaymentWizardSelection({
    storedCountryCode: "US"
  });
  assert.deepEqual({
    method: initialSelection.selectedMethod,
    country: initialSelection.selectedCountryCode,
    region: initialSelection.selectedRegion,
    picker: initialSelection.countryPickerOpen
  }, {
    method: null,
    country: "US",
    region: "north-america",
    picker: false
  });

  const bankSelection = updateOpenReceivePaymentWizardSelection(initialSelection, {
    type: "select_method",
    method: "bank",
    storedCountryCode: null
  });
  assert.equal(bankSelection.selectedMethod, "bank");
  assert.equal(bankSelection.countryPickerOpen, false);

  const europeSelection = updateOpenReceivePaymentWizardSelection(bankSelection, {
    type: "select_region",
    region: "europe"
  });
  assert.equal(europeSelection.selectedRegion, "europe");
  assert.equal(
    createOpenReceivePaymentWizardModel(europeSelection).visibleRegionCountries
      .some((country) => country.code === europeSelection.selectedCountryCode),
    true
  );
  const countryPickerModel = createOpenReceiveCountryPickerModel({
    countries: createOpenReceivePaymentWizardModel(europeSelection).wizard.railCountries,
    selectedCountryCode: europeSelection.selectedCountryCode,
    selectedRegion: "europe",
    hoveredCountryCode: "GB"
  });
  assert.equal(countryPickerModel.regions.some((region) => region.id === "europe" && region.count > 0), true);
  assert.equal(
    countryPickerModel.visibleRegionCountries.every(
      (country) => getOpenReceiveRegionForCountry(country.code) === "europe"
    ),
    true
  );
  assert.equal(countryPickerModel.hoveredCountry?.code, "GB");
  assert.equal(
    countryPickerModel.mapCountries.some(
      (entry) =>
        entry.country.code === countryPickerModel.selectedCountry?.code &&
        entry.point[0] >= 0 &&
        entry.point[0] <= OPENRECEIVE_COUNTRY_MAP_WIDTH &&
        entry.point[1] >= 0 &&
        entry.point[1] <= OPENRECEIVE_COUNTRY_MAP_HEIGHT
    ),
    true
  );

  const countrySelection = updateOpenReceivePaymentWizardSelection(europeSelection, {
    type: "select_country",
    countryCode: "GB"
  });
  assert.equal(countrySelection.countryPickerOpen, false);
  assert.equal(countrySelection.selectedRegion, "europe");

  const bitcoinSelection = updateOpenReceivePaymentWizardSelection(countrySelection, {
    type: "select_method",
    method: "bitcoin"
  });
  const routeSelection = updateOpenReceivePaymentWizardSelection(bitcoinSelection, {
    type: "select_route",
    route: "btc-lightning"
  });
  const routeModel = createOpenReceivePaymentWizardModel(routeSelection);
  assert.equal(routeModel.selectedRoute, "btc-lightning");
  assert.ok(routeModel.routeAssets.length > 0);
  const routeAssetDisplays = createOpenReceiveWizardRouteAssetDisplays(routeModel.routeAssets, {
    selectedRoute: routeModel.selectedRoute
  });
  const lightningRouteAsset = routeAssetDisplays.find((asset) => asset.id === "btc-lightning");
  assert.equal(lightningRouteAsset?.selected, true);
  assert.equal(lightningRouteAsset?.subtitle, "Lightning Network");
  assert.match(lightningRouteAsset?.icon ?? "", /assets\/icons\/lightning\.svg/);

  const cardState = createOpenReceivePaymentWizardState({
    selectedMethod: "card",
    selectedCountryCode: "US"
  });
  assert.equal(cardState.selectedRail, "card");
  assert.equal(cardState.selectedCountry?.code, "US");
  assert.ok(cardState.routes.length > 0);
  const cardRouteDisplays = createOpenReceiveWizardRouteDisplays(cardState.routes);
  assert.equal(cardRouteDisplays[0].title, "Credit / debit card");
  assert.equal(cardRouteDisplays[0].subtitle, "USD");
  assert.equal(cardRouteDisplays[0].providers.length <= OPENRECEIVE_PROVIDER_PREVIEW_LIMIT, true);
  assert.equal(cardRouteDisplays[0].providers[0].copyLabel, openReceiveCheckoutLabels.copyInvoice);
  assert.equal(cardRouteDisplays[0].providers[0].copiedLabel, openReceiveCheckoutLabels.copied);
  assert.equal(cardRouteDisplays[0].providers[0].openLabel, "How To Pay");
  assert.match(cardRouteDisplays[0].providers[0].url, /^https:\/\/docs\.strike\.me/);
  assert.match(cardRouteDisplays[0].providers[0].icon, /assets\/provider-icons\/strike\.png/);

  const firstCrypto = getOpenReceiveAltcoinAssets().find((asset) => asset.route !== undefined);
  assert.ok(firstCrypto?.route);
  const cryptoState = createOpenReceivePaymentWizardState({
    selectedMethod: "crypto",
    selectedCryptoRoute: firstCrypto.route
  });
  assert.equal(cryptoState.selectedRail, null);
  assert.equal(cryptoState.selectedRouteId, firstCrypto.route);
  assert.ok(cryptoState.routes.length > 0);
});

test("React payment state primitive renders current state", () => {
  const html = renderToStaticMarkup(
    React.createElement(OpenReceivePaymentState, {
      state: "settled"
    })
  );

  assert.match(html, /data-openreceive-state="settled"/);
  assert.match(html, />settled</);
});

test("React checkout supports design-system component and class slots", () => {
  function CustomQr(props) {
    return React.createElement(
      "figure",
      {
        className: props.className,
        "data-slot-qr": props.invoice
      },
      "QR"
    );
  }

  function CustomPaymentState(props) {
    return React.createElement(
      "strong",
      {
        className: props.className,
        "data-slot-state": props.state
      },
      props.state
    );
  }

  function CustomSummary(props) {
    return React.createElement(
      "aside",
      {
        className: props.className,
        "data-slot-summary": ""
      },
      props.amountLabel,
	      React.createElement(props.PaymentStateComponent, {
	        state: props.transactionStateLabel,
	        className: props.classNames.paymentState
	      })
	    );
  }

  function CustomButton(props) {
    return React.createElement(
      "button",
      {
        className: props.className,
        type: props.type,
        "data-slot-button": ""
      },
      props.children
    );
  }

  const html = renderToStaticMarkup(
    React.createElement(OpenReceiveCheckout, {
      invoice: "lnbc-slot-test",
      payment_hash: "c".repeat(64),
      amount_msats: 200000,
      transaction_state: "pending",
      components: {
        Button: CustomButton,
        QRCode: CustomQr,
        InvoiceSummary: CustomSummary,
        PaymentState: CustomPaymentState
      },
      classNames: {
        root: "app-root",
        qr: "app-qr",
        summary: "app-summary",
        paymentState: "app-state",
        copyButton: "app-copy",
        openWalletButton: "app-open"
      }
    })
  );

  assert.match(html, /class="app-root"/);
  assert.match(html, /data-slot-qr="lnbc-slot-test"/);
  assert.match(html, /class="app-qr"/);
  assert.match(html, /data-slot-summary=""/);
  assert.match(html, /class="app-summary"/);
  assert.match(html, /data-slot-state="pending"/);
  assert.match(html, /class="app-state"/);
  assert.match(html, /data-slot-button=""/);
  assert.match(html, /class="app-copy"/);
  assert.match(html, />Copy invoice</);
  assert.doesNotMatch(html, /class="app-open"/);
  assert.doesNotMatch(html, />Open Wallet</);
  assert.doesNotMatch(html, /nostr\+walletconnect/);
});

test("React checkout render prop can replace default visible markup", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      OpenReceiveCheckout,
      {
        invoice_id: "or_inv_render_prop",
        invoice: "lnbc-render-prop",
        amount_msats: 1000,
        transaction_state: "pending",
        workflow_state: "verifying",
        expires_at: 9999999999
      },
      (checkout) =>
        React.createElement(
          "p",
          {
            "data-custom-checkout": checkout.amountLabel,
            "data-status": checkout.status.title,
            "data-countdown-prefix": checkout.status.countdownPrefix
          },
          checkout.lightningUri,
          " ",
          checkout.status.countdownLabel
        )
    )
  );

  assert.match(html, /data-openreceive-checkout/);
  assert.match(html, /data-custom-checkout="1 sat"/);
  assert.match(html, /data-status="Waiting for payment"/);
  assert.match(html, /data-countdown-prefix="Invoice expires in"/);
  assert.match(html, />lightning:lnbc-render-prop /);
  assert.doesNotMatch(html, /aria-label="Lightning invoice"/);
});

test("React provider shares checkout state with a consumer hook", () => {
  function CheckoutConsumer() {
    const checkout = useOpenReceiveCheckoutContext();
    return React.createElement(
      "strong",
      { "data-provider-amount": checkout.amountLabel },
      checkout.lightningUri
    );
  }

  const html = renderToStaticMarkup(
    React.createElement(
      OpenReceiveProvider,
      {
        invoice: "lnbc-provider-context",
        amount_msats: 1000
      },
      React.createElement(CheckoutConsumer)
    )
  );

  assert.match(html, /data-provider-amount="1 sat"/);
  assert.match(html, />lightning:lnbc-provider-context</);
});

test("React provider render prop receives the controller-backed checkout model", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      OpenReceiveProvider,
      {
        invoice_id: "or_inv_provider_render",
        invoice: "lnbc-provider-render",
        amount_msats: 2000,
        transaction_state: "pending",
        workflow_state: "invoice_created"
      },
      (checkout) =>
        React.createElement(
          "span",
          {
            "data-provider-render": checkout.amountLabel,
            "data-provider-status": checkout.status.title,
            "data-provider-reload": typeof checkout.reloadState,
            "data-provider-retry": typeof checkout.retry,
            "data-provider-refresh": typeof checkout.refreshExpiredInvoice,
            "data-provider-cancel": typeof checkout.cancel
          },
          checkout.lightningUri
        )
    )
  );

  assert.match(html, /data-provider-render="2 sats"/);
  assert.match(html, /data-provider-status="Waiting for payment"/);
  assert.match(html, /data-provider-reload="function"/);
  assert.match(html, /data-provider-retry="function"/);
  assert.match(html, /data-provider-refresh="function"/);
  assert.match(html, /data-provider-cancel="function"/);
  assert.match(html, />lightning:lnbc-provider-render</);
});

test("React checkout context fails clearly outside the provider", () => {
  function CheckoutConsumer() {
    useOpenReceiveCheckoutContext();
    return React.createElement("span", null, "never");
  }

  assert.throws(
    () => renderToStaticMarkup(React.createElement(CheckoutConsumer)),
    /OpenReceiveProvider/
  );
});

test("React primitive aliases point to the stable components", () => {
  assert.equal(InvoiceSummary, OpenReceiveInvoiceSummary);
  assert.equal(CopyInvoiceButton, OpenReceiveCopyButton);
  assert.equal(OpenWalletButton, OpenReceiveOpenWalletButton);
  assert.equal(PaymentState, OpenReceivePaymentState);
});

test("React package centralizes transient copy feedback timing", () => {
  const source = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );

  assert.match(source, /function useOpenReceiveTransientValue/);
  assert.match(source, /createOpenReceiveTransientFeedbackController/);
  assert.doesNotMatch(source, /globalThis\.setTimeout/);
  assert.equal(source.match(/OPENRECEIVE_COPY_FEEDBACK_MS/g)?.length, 2);
  assert.doesNotMatch(source, /setCopied\(false\)/);
  assert.doesNotMatch(source, /setCopiedProviderId\(null\)/);
});

test("React package exposes shared browser-owned checkout styles", () => {
  const manifest = JSON.parse(readFileSync(
    path.join(process.cwd(), "packages/js/react/package.json"),
    "utf8"
  ));
  const browserStyles = readFileSync(
    path.join(process.cwd(), "packages/js/browser/src/styles.css"),
    "utf8"
  );
  const reactStyles = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/styles.css"),
    "utf8"
  );

  assert.equal(manifest.exports["./styles.css"], "./src/styles.css");
  assert.match(browserStyles, /\[data-openreceive-checkout\]/);
  assert.match(reactStyles, /@openreceive\/browser\/styles\.css/);
});

test("React default checkout passes controller actions into default buttons", () => {
  const source = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );

  assert.match(source, /copyInvoice: checkoutModel\.copyInvoice/);
  assert.doesNotMatch(source, /openWallet: checkoutModel\.openWallet/);
  assert.match(source, /copyInvoice === undefined/);
  assert.match(source, /openWallet === undefined/);
});
