import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  openReceiveCheckoutElementStyles,
  openReceiveThemeToggleElementStyles
} from "@openreceive/browser/internal";
import {
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  defineOpenReceiveElements,
  formatMsats,
  renderCheckoutHtml,
  renderOpenReceivePaymentWizardHtml,
  renderOpenReceiveThemeToggleHtml
} from "@openreceive/elements";

test("elements render display-safe checkout HTML", () => {
  const html = renderCheckoutHtml({
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
    expires_at: Math.floor(Date.now() / 1000) + 600,
    theme: "dark"
  });

  assert.doesNotMatch(html, /lightning:lnbc-test/);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /Waiting for payment/);
  assert.match(html, />\$0\.05</);
  assert.match(html, /Invoice expires in/);
  assert.match(html, /200 sats/);
  assert.match(html, /pending/);
  assert.doesNotMatch(html, /aaaaaaaa\.\.\.aaaaaaaa/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /lnbc-test/);
  assert.match(html, />Copy invoice</);
  assert.doesNotMatch(html, />Open Wallet</);
  assert.match(html, /data-openreceive-wizard/);
  assert.match(html, /Credit Card/);
  assert.match(html, /Bank Transfer/);
  assert.match(html, /Bitcoin/);
  assert.match(html, /Crypto/);
});

test("elements derive waiting display from browser checkout state", () => {
  const expiredHtml = renderCheckoutHtml({
    invoice_id: "or_inv_expired",
    invoice: "lnbc-expired",
    payment_hash: "b".repeat(64),
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: Math.floor(Date.now() / 1000) - 1
  });

  assert.match(expiredHtml, /Invoice expired/);
  assert.match(expiredHtml, /Start over/);
  assert.doesNotMatch(expiredHtml, /Invoice expires in/);
  assert.doesNotMatch(expiredHtml, /data-openreceive-qr/);
  assert.doesNotMatch(expiredHtml, /<textarea/);
  assert.doesNotMatch(expiredHtml, /lnbc-expired/);
  assert.doesNotMatch(expiredHtml, /data-openreceive-wizard/);
  assert.doesNotMatch(expiredHtml, /<span part="spinner"/);
});

test("elements render payment wizard route choices and providers from browser state", () => {
  const firstStep = renderOpenReceivePaymentWizardHtml();
  assert.match(firstStep, /Credit Card/);
  assert.match(firstStep, /Bank Transfer/);
  assert.match(firstStep, /Bitcoin/);
  assert.match(firstStep, /Crypto/);
  assert.match(firstStep, /assets\/icons\/card\.svg/);
  assert.match(firstStep, /assets\/icons\/btc\.svg/);
  assert.doesNotMatch(firstStep, /change payment method/);

  const cryptoStep = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "crypto",
    selectedCryptoRoute: "usdt"
  });
  assert.match(cryptoStep, /data-or-breadcrumb="method"/);
  assert.match(cryptoStep, />Payment method<\/span>/);
  assert.match(cryptoStep, /data-or-breadcrumb="route"/);
  assert.match(cryptoStep, />Crypto<\/span>/);
  assert.doesNotMatch(cryptoStep, /part="method-grid"/);
  assert.match(cryptoStep, /Tether/);
  assert.doesNotMatch(cryptoStep, /part="route-picker"/);
  assert.doesNotMatch(cryptoStep, /assets\/icons\/usdt\.svg/);
  assert.match(cryptoStep, /assets\/provider-icons\/boltz\.png/);
  assert.doesNotMatch(cryptoStep, /Copy invoice/);
  assert.match(cryptoStep, /How To Pay/);
  assert.doesNotMatch(cryptoStep, /Pays invoices/);

  const bitcoinStep = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "bitcoin"
  });
  assert.match(bitcoinStep, /data-or-breadcrumb="method"/);
  assert.match(bitcoinStep, />Payment method<\/span>/);
  assert.match(bitcoinStep, />Bitcoin<\/span>/);
  assert.doesNotMatch(bitcoinStep, /data-or-breadcrumb="route"/);
  assert.doesNotMatch(bitcoinStep, /data-or-route="btc-lightning"/);
  assert.doesNotMatch(bitcoinStep, /part="route-picker"/);
  assert.doesNotMatch(bitcoinStep, /Choose Bitcoin Lightning/);
  assert.match(bitcoinStep, /Bitcoin Lightning/);
  assert.match(bitcoinStep, /browser wallet/);
  assert.match(bitcoinStep, /mobile wallet/);
  assert.match(bitcoinStep, /How To Pay/);

  const cardStep = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "card",
    selectedCountryCode: "US"
  });
  assert.match(cardStep, /data-or-breadcrumb="method"/);
  assert.match(cardStep, />Payment method<\/span>/);
  assert.match(cardStep, />Credit Card<\/span>/);
  assert.doesNotMatch(cardStep, /part="method-grid"/);
  assert.doesNotMatch(cardStep, /Pick your country/);
  assert.match(cardStep, /Credit \/ debit card/);
  assert.doesNotMatch(cardStep, />USD<\/p>/);
  assert.match(cardStep, /part="country-select"/);
  assert.match(cardStep, /<select data-or-country="US">/);
  assert.match(cardStep, />United States<\/option>/);
  assert.match(cardStep, /data-or-provider-tutorial="strike"/);
  assert.doesNotMatch(cardStep, /href="https:\/\/docs\.strike\.me/);
  assert.doesNotMatch(cardStep, /Switch country/);
  assert.doesNotMatch(cardStep, /part="country-map"/);
  assert.doesNotMatch(cardStep, /US supported|Not US/);

  const tutorialIntro = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "card",
    selectedCountryCode: "US",
    activeTutorialProviderId: "strike",
    activeTutorialIndex: 0
  });
  assert.match(tutorialIntro, /Pay a Lightning invoice with Strike/);
  assert.match(tutorialIntro, /part="tutorial-header-logo" alt="" src="[^"]*assets\/provider-icons\/strike\.png"/);
  assert.match(tutorialIntro, /part="tutorial-provider-logo" alt="" src="[^"]*assets\/provider-icons\/strike\.png"/);
  assert.match(tutorialIntro, /It's easy to make this payment using Strike\./);
  assert.match(tutorialIntro, /The first step is to copy the invoice to your clipboard\./);
  assert.match(tutorialIntro, />Copy invoice</);
  assert.match(tutorialIntro, /Step 1 of 5/);
  assert.doesNotMatch(tutorialIntro, /assets\/pay_tutorials\/strike-1\.webp/);

  const copiedTutorialIntro = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "card",
    selectedCountryCode: "US",
    activeTutorialProviderId: "strike",
    activeTutorialIndex: 0,
    activeTutorialCopied: true
  });
  assert.match(copiedTutorialIntro, /Copied! Click next below to continue with tutorial\./);

  const tutorialStep = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "card",
    selectedCountryCode: "US",
    activeTutorialProviderId: "strike",
    activeTutorialIndex: 2
  });
  assert.match(tutorialStep, /Pay a Lightning invoice with Strike/);
  assert.match(tutorialStep, /part="tutorial-header-logo" alt="" src="[^"]*assets\/provider-icons\/strike\.png"/);
  assert.match(tutorialStep, /assets\/pay_tutorials\/strike-2\.webp/);
  assert.match(tutorialStep, /Choose Bitcoin wallet/);
  assert.match(tutorialStep, /Step 3 of 5/);

  const finalTutorialStep = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "card",
    selectedCountryCode: "US",
    activeTutorialProviderId: "strike",
    activeTutorialIndex: 4
  });
  assert.match(finalTutorialStep, /Step 5 of 5/);
  assert.match(finalTutorialStep, />Exit<\/button>/);
  assert.doesNotMatch(finalTutorialStep, />Next<\/button>/);
});

test("elements render package-owned theme toggle HTML", () => {
  const html = renderOpenReceiveThemeToggleHtml("dark mode");
  assert.match(html, /data-openreceive-theme-toggle/);
  assert.match(html, /part="button"/);
  assert.match(html, /dark mode/);
  assert.doesNotMatch(html, /or-theme-toggle-icon-dark/);
  assert.equal(OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME, "openreceive-theme-toggle");
});

test("elements package exposes shared browser-owned checkout styles", () => {
  const manifest = JSON.parse(readFileSync(
    path.join(process.cwd(), "packages/js/elements/package.json"),
    "utf8"
  ));
  const styles = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/styles.css"),
    "utf8"
  );
  const source = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  assert.equal(manifest.exports["./styles.css"], "./src/styles.css");
  assert.match(styles, /@openreceive\/browser\/styles\.css/);
  assert.match(
    renderCheckoutHtml({ invoice: "lnbc-style-test" }),
    new RegExp(escapeRegExp(openReceiveCheckoutElementStyles.trim().slice(0, 20)))
  );
  assert.match(
    renderOpenReceiveThemeToggleHtml("dark mode"),
    new RegExp(escapeRegExp(openReceiveThemeToggleElementStyles.trim().slice(0, 20)))
  );
  assert.match(source, /openReceiveCheckoutElementStyles/);
  assert.match(source, /openReceiveThemeToggleElementStyles/);
  assert.doesNotMatch(source, /--or-good-bg/);
  assert.doesNotMatch(source, /--or-theme-toggle-bg/);
});

test("elements hide invoice text and reject NWC strings", () => {
  const html = renderCheckoutHtml({
    invoice: "lnbc-test<&"
  });

  assert.doesNotMatch(html, /lnbc-test/);
  assert.doesNotMatch(html, /<textarea/);
  assert.throws(
    () =>
      renderCheckoutHtml({
        invoice: `nostr+walletconnect://${"a".repeat(64)}?secret=${"b".repeat(64)}`
      }),
    /must not be an NWC/
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("elements format sat and msat amounts", () => {
  assert.equal(formatMsats(1000), "1 sat");
  assert.equal(formatMsats(2000), "2 sats");
  assert.equal(formatMsats(1500), "1500 msats");
  assert.throws(() => formatMsats(-1), /non-negative safe integer/);
});

test("elements definition fails clearly without DOM custom elements", () => {
  assert.throws(
    () =>
      defineOpenReceiveElements({
        registry: undefined
      }),
    /Custom elements are unavailable/
  );
});
