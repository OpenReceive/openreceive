import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  OPENRECEIVE_COUNTRY_MAP_VIEW_BOX,
  openReceiveCheckoutElementStyles,
  openReceiveThemeToggleElementStyles,
  openReceiveCountryMapRegions
} from "@openreceive/browser";
import {
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  defineOpenReceiveElements,
  formatMsats,
  renderOpenReceiveCheckoutHtml,
  renderOpenReceivePaymentWizardHtml,
  renderOpenReceiveThemeToggleHtml
} from "@openreceive/elements";

test("elements render display-safe checkout HTML", () => {
  const html = renderOpenReceiveCheckoutHtml({
    invoice_id: "or_inv_test",
    invoice: "lnbc-test",
    payment_hash: "a".repeat(64),
    amount_msats: 200000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: Math.floor(Date.now() / 1000) + 600,
    checkout: {
      events_url: "/openreceive/v1/invoices/or_inv_test/events"
    },
    theme: "dark"
  });

  assert.match(html, /lightning:lnbc-test/);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /Waiting for payment/);
  assert.match(html, /Invoice expires in/);
  assert.match(html, /200 sats/);
  assert.match(html, /pending/);
  assert.match(html, /aaaaaaaa\.\.\.aaaaaaaa/);
  assert.match(html, />Copy BOLT11</);
  assert.match(html, /data-openreceive-wizard/);
  assert.match(html, /Credit Card/);
  assert.match(html, /Bank Transfer/);
  assert.match(html, /Bitcoin/);
  assert.match(html, /Crypto/);
});

test("elements derive waiting display from browser checkout state", () => {
  const expiredHtml = renderOpenReceiveCheckoutHtml({
    invoice_id: "or_inv_expired",
    invoice: "lnbc-expired",
    payment_hash: "b".repeat(64),
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: Math.floor(Date.now() / 1000) - 1
  });

  assert.match(expiredHtml, /Invoice expires in/);
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

  const cryptoStep = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "crypto",
    selectedCryptoRoute: "usdt"
  });
  assert.match(cryptoStep, /Tether/);
  assert.match(cryptoStep, /assets\/icons\/usdt\.svg/);
  assert.match(cryptoStep, /Copy BOLT11/);
  assert.match(cryptoStep, /Open /);

  const cardStep = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "card",
    selectedCountryCode: "US"
  });
  assert.match(cardStep, /Credit \/ debit card in United States/);
  assert.match(cardStep, /Switch country/);

  const countryStep = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "card",
    selectedCountryCode: "US",
    countryPickerOpen: true
  });
  assert.match(countryStep, /part="country-map"/);
  assert.match(countryStep, /aria-label="Country map"/);
  assert.match(countryStep, new RegExp(`viewBox="${OPENRECEIVE_COUNTRY_MAP_VIEW_BOX}"`));
  assert.match(countryStep, new RegExp(`data-or-region-shape="${openReceiveCountryMapRegions[0].id}"`));
  assert.match(countryStep, /data-or-country="US"/);
  assert.match(countryStep, /part="map-readout"/);
});

test("elements render package-owned theme toggle HTML", () => {
  const html = renderOpenReceiveThemeToggleHtml("Dark mode");
  assert.match(html, /data-openreceive-theme-toggle/);
  assert.match(html, /part="button"/);
  assert.match(html, /Dark mode/);
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
    renderOpenReceiveCheckoutHtml({ invoice: "lnbc-style-test" }),
    new RegExp(escapeRegExp(openReceiveCheckoutElementStyles.trim().slice(0, 20)))
  );
  assert.match(
    renderOpenReceiveThemeToggleHtml("Dark mode"),
    new RegExp(escapeRegExp(openReceiveThemeToggleElementStyles.trim().slice(0, 20)))
  );
  assert.match(source, /openReceiveCheckoutElementStyles/);
  assert.match(source, /openReceiveThemeToggleElementStyles/);
  assert.doesNotMatch(source, /--or-good-bg/);
  assert.doesNotMatch(source, /--or-theme-toggle-bg/);
});

test("elements escape invoice text and reject NWC strings", () => {
  const html = renderOpenReceiveCheckoutHtml({
    invoice: "lnbc-test<&"
  });

  assert.match(html, /lnbc-test&lt;&amp;/);
  assert.throws(
    () =>
      renderOpenReceiveCheckoutHtml({
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
