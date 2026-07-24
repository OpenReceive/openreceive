import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  openReceiveCheckoutElementStyles
} from "@openreceive/browser/internal";
import {
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  defineOpenReceiveElements,
  formatMsats,
  renderCheckoutCreatingHtml,
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
  assert.match(html, /Bitcoin Lightning invoice/);
  assert.match(html, /Waiting for payment/);
  // Fiat amount lives under the QR caption (not a duplicate meta badge while pending).
  assert.match(html, /\$0\.05/);
  assert.match(html, /Invoice expires in/);
  assert.match(html, /200 sats/);
  // Pending status is conveyed by WaitingState; avoid a redundant "pending" badge.
  assert.doesNotMatch(html, /part="state"/);
  assert.doesNotMatch(html, /aaaaaaaa\.\.\.aaaaaaaa/);
  assert.doesNotMatch(html, /<textarea/);
  // BOLT11 may appear only in the Decode href — never as visible invoice text.
  assert.doesNotMatch(
    html.replace(/https:\/\/rizful\.com\/decode_invoice\?invoice=[^"'\s>]*/g, ""),
    /lnbc-test/,
  );
  assert.match(html, />Copy invoice</);
  assert.match(html, />Decode</);
  assert.match(html, /rizful\.com\/decode_invoice\?invoice=lnbc-test/);
  assert.doesNotMatch(html, />Open Wallet</);
  assert.match(html, /data-openreceive-wizard/);
  assert.match(html, /Bitcoin/);
  assert.doesNotMatch(html, />Crypto</);
  assert.doesNotMatch(html, /Credit Card/);
  assert.doesNotMatch(html, /Bank Transfer/);
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
  assert.match(firstStep, /Bitcoin/);
  assert.doesNotMatch(firstStep, />Crypto</);
  assert.doesNotMatch(firstStep, /Credit Card/);
  assert.doesNotMatch(firstStep, /Bank Transfer/);
  assert.match(firstStep, /assets\/icons\/btc\.svg/);
  assert.doesNotMatch(firstStep, /assets\/icons\/card\.svg/);
  assert.doesNotMatch(firstStep, /change payment method/);

  const loadingStep = renderOpenReceivePaymentWizardHtml({
    currenciesLoading: true,
  });
  assert.match(loadingStep, /Bitcoin/);
  assert.match(loadingStep, /Loading currencies/);
  assert.doesNotMatch(loadingStep, />Crypto</);

  const belowMin = renderOpenReceivePaymentWizardHtml({
    amountMsats: 3_000_000,
    fiat: { currency: "USD", value: "2.00" },
    swapOptions: [
      {
        pay_in_asset: "ETH_ETH",
        label: "ETH",
        network_label: "Ethereum",
        provider: "fixedfloat",
        available: false,
        unavailable_reason: "amount_too_small",
        minimum_invoice_amount_msats: 25_425_000,
      },
    ],
  });
  assert.match(belowMin, /Bitcoin/);
  assert.match(belowMin, /ETH/);
  assert.match(belowMin, /Minimum amount \$16\.95/);
  assert.doesNotMatch(belowMin, /Minimum payment/);
  assert.match(
    belowMin,
    /aria-disabled="true"[\s\S]*?<\/button>\s*<span class="[^"]*text-base-content\/55[^"]*">Minimum amount/,
  );

  const usdtNetworksBelowMin = renderOpenReceivePaymentWizardHtml({
    amountMsats: 3_000_000,
    fiat: { currency: "USD", value: "2.00" },
    selectedPickerKey: "swap:USDT",
    swapOptions: [
      {
        pay_in_asset: "USDT_TRON",
        label: "USDT",
        network_label: "Tron",
        provider: "fixedfloat",
        available: false,
        unavailable_reason: "amount_too_small",
        minimum_invoice_amount_msats: 25_425_000,
      },
      {
        pay_in_asset: "USDT_SOL",
        label: "USDT",
        network_label: "Solana",
        provider: "fixedfloat",
        available: true,
        minimum_invoice_amount_msats: 2_800_000,
      },
      {
        pay_in_asset: "USDT_ETH",
        label: "USDT",
        network_label: "Ethereum",
        provider: "fixedfloat",
        available: false,
        unavailable_reason: "amount_too_small",
        minimum_invoice_amount_msats: 25_425_000,
      },
    ],
  });
  assert.match(usdtNetworksBelowMin, /Choose USDT network/);
  assert.match(usdtNetworksBelowMin, />Tron</);
  assert.match(usdtNetworksBelowMin, />Solana</);
  assert.match(usdtNetworksBelowMin, />Ethereum</);
  // Limit notes sit under greyed network tiles — not concatenated into the button label.
  assert.doesNotMatch(usdtNetworksBelowMin, /Tron · Minimum/);
  assert.doesNotMatch(usdtNetworksBelowMin, /Ethereum · Minimum/);
  assert.match(
    usdtNetworksBelowMin,
    /aria-disabled="true"[\s\S]*?>Tron<\/span>[\s\S]*?<\/button>\s*<span class="[^"]*text-base-content\/55[^"]*">Minimum amount/,
  );
  assert.match(
    usdtNetworksBelowMin,
    /aria-disabled="true"[\s\S]*?>Ethereum<\/span>[\s\S]*?<\/button>\s*<span class="[^"]*text-base-content\/55[^"]*">Minimum amount/,
  );

  const cryptoStep = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "crypto",
    selectedCryptoRoute: "usdt"
  });
  assert.match(cryptoStep, /data-or-breadcrumb="method"/);
  assert.match(cryptoStep, />Switch payment method<\/span>/);
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
  assert.match(bitcoinStep, />Switch payment method<\/span>/);
  assert.match(bitcoinStep, />Bitcoin<\/span>/);
  assert.doesNotMatch(bitcoinStep, /data-or-breadcrumb="route"/);
  assert.doesNotMatch(bitcoinStep, /data-or-route="btc-lightning"/);
  assert.doesNotMatch(bitcoinStep, /part="route-picker"/);
  assert.doesNotMatch(bitcoinStep, /Choose Bitcoin Lightning/);
  assert.match(bitcoinStep, /Bitcoin Lightning/);
  assert.match(bitcoinStep, /browser wallet/);
  assert.match(bitcoinStep, /mobile wallet/);
  assert.match(bitcoinStep, /How To Pay/);
  assert.doesNotMatch(bitcoinStep, /part="country-select"/);
  assert.doesNotMatch(bitcoinStep, /Credit \/ debit card/);

  const tutorialIntro = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "bitcoin",
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
    selectedMethod: "bitcoin",
    activeTutorialProviderId: "strike",
    activeTutorialIndex: 0,
    activeTutorialCopied: true
  });
  assert.match(copiedTutorialIntro, /Copied! Click next below to continue with tutorial\./);

  const tutorialStep = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "bitcoin",
    activeTutorialProviderId: "strike",
    activeTutorialIndex: 2
  });
  assert.match(tutorialStep, /Pay a Lightning invoice with Strike/);
  assert.match(tutorialStep, /part="tutorial-header-logo" alt="" src="[^"]*assets\/provider-icons\/strike\.png"/);
  assert.match(tutorialStep, /assets\/pay_tutorials\/strike-2\.webp/);
  assert.match(tutorialStep, /Choose Bitcoin wallet/);
  assert.match(tutorialStep, /Step 3 of 5/);

  const finalTutorialStep = renderOpenReceivePaymentWizardHtml({
    selectedMethod: "bitcoin",
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

  assert.equal(manifest.exports["./styles.css"], "./dist/styles.css");
  assert.match(styles, /@openreceive\/browser\/styles\.css/);
  assert.match(
    renderCheckoutHtml({ invoice: "lnbc-style-test" }),
    new RegExp(escapeRegExp(openReceiveCheckoutElementStyles.trim().slice(0, 20)))
  );
  assert.match(
    renderOpenReceiveThemeToggleHtml("dark mode"),
    new RegExp(escapeRegExp(openReceiveCheckoutElementStyles.trim().slice(0, 20)))
  );
  assert.match(source, /openReceiveCheckoutElementStyles/);
  assert.doesNotMatch(source, /openReceiveThemeToggleElementStyles/);
  assert.doesNotMatch(source, /--or-good-bg/);
  assert.doesNotMatch(source, /--or-theme-toggle-bg/);
});

test("elements hide invoice text and reject NWC strings", () => {
  const html = renderCheckoutHtml({
    invoice: "lnbc-test<&"
  });

  assert.doesNotMatch(
    html.replace(/https:\/\/rizful\.com\/decode_invoice\?invoice=[^"'\s>]*/g, ""),
    /lnbc-test/,
  );
  assert.match(html, /rizful\.com\/decode_invoice\?invoice=/);
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
  assert.equal(formatMsats(1500), "1,500 msats");
  assert.throws(() => formatMsats(-1), /non-negative safe integer/);
});

test("elements expose a create-mode prefix attribute and creating placeholder", () => {
  // Create mode is driven by `order-id` (+ optional `prefix`) with no `invoice`.
  assert.equal(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId, "order-id");
  assert.equal(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix, "prefix");

  const dark = renderCheckoutCreatingHtml("dark");
  assert.match(dark, /data-openreceive-creating/);
  assert.match(dark, /Creating checkout/);
  // The theme lands on the root section tag (the <style> block itself mentions data-theme).
  assert.match(dark, /part="root" data-theme="dark"/);
  assert.match(dark, /part="spinner"/);

  const noTheme = renderCheckoutCreatingHtml();
  // Unset theme defaults to light so shadow DOM never inherits OS dark via :root.
  assert.match(noTheme, /part="root" data-theme="light"/);
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
