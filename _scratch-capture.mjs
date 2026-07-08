import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderSwapDepositPanel, Checkout } from "@openreceive/react";
import { createQrPayloadSvg, createQrSvg } from "@openreceive/browser/internal";
import { readFileSync, writeFileSync } from "node:fs";

const nowSec = Math.floor(Date.now() / 1000);
const lightning = {
  invoice_id: "or_inv_lightning",
  rail: "lightning",
  invoice: "lnbc194180n1pexampleinvoicepayloadforpreviewqrxqyjw5q",
  payment_hash: "a".repeat(64),
  amount_msats: 19418000,
  transaction_state: "pending",
  workflow_state: "verifying",
  expires_at: nowSec + 583,
  fiat_quote: { fiat: { currency: "USD", value: "12.00" } },
};
const swapInvoice = {
  invoice_id: "or_inv_swap",
  rail: "swap",
  invoice: null,
  payment_hash: "b".repeat(64),
  amount_msats: 19418000,
  transaction_state: "pending",
  workflow_state: "invoice_created",
  expires_at: nowSec + 555,
  swap: {
    attempt_id: "or_inv_swap",
    provider: "fixedfloat",
    provider_order_id: "ff-1",
    pay_in_asset: "USDT_SOL",
    deposit_address: "BispAWTSfhYBPtVMv98ZehKpBidK2s31akzu1ViEPxwz",
    deposit_amount: "12.21700000",
    provider_state: "awaiting_deposit",
    provider_expires_at: nowSec + 555,
  },
};
const checkout = {
  checkout_id: "or_chk_test",
  order_id: "order_test",
  status: "open",
  amount_msats: 19418000,
  fiat: { currency: "USD", value: "12.00" },
  active: lightning,
  invoices: [swapInvoice, lightning],
  payment_methods: [
    { pay_in_asset: "USDT_SOL", label: "USDT", network_label: "Solana", provider: "fixedfloat", available: true },
    { pay_in_asset: "SOL_SOL", label: "SOL", network_label: "Solana", provider: "fixedfloat", available: true },
  ],
};

function svgToDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// --- AFTER: focused swap view (Lightning section hidden) ---
const panel = renderSwapDepositPanel({
  invoice: swapInvoice,
  now: nowSec,
  onRefund: async () => {},
  onBackToLightning: () => {},
});
const afterInner = React.createElement(
  "div",
  { className: "or-wizard" },
  React.createElement(
    "nav",
    { className: "or-wizard-breadcrumbs" },
    React.createElement("button", { className: "or-wizard-breadcrumb", type: "button" }, "Payment method"),
    React.createElement("span", { className: "or-wizard-breadcrumb-separator" }, "/"),
    React.createElement("span", { className: "or-wizard-breadcrumb-current" }, "USDT · Solana")
  ),
  React.createElement("div", { className: "or-wizard-results" }, panel)
);
let afterHtml = renderToStaticMarkup(afterInner);

// --- BEFORE flow reference: the standard checkout with Lightning + method grid ---
let beforeHtml = renderToStaticMarkup(React.createElement(Checkout, { checkout, polling: false }));

// Inject real QR images (the components generate these in an effect that does not run
// during static render).
const swapQr = svgToDataUri(await createQrPayloadSvg(swapInvoice.swap.deposit_address, { width: 220 }));
const lnQr = svgToDataUri(await createQrSvg(lightning.invoice, { width: 420 }));
afterHtml = afterHtml.replace('<img alt="" class="or-swap-qr"/>', `<img alt="" class="or-swap-qr" src="${swapQr}"/>`);
// The default checkout QR renders as a container with data-openreceive-qr; inject an <img> if empty.
beforeHtml = beforeHtml.replace(/(<div[^>]*data-openreceive-qr="")([^>]*>)(<\/div>)/,
  `$1$2<img alt="" style="display:block;width:100%;height:auto" src="${lnQr}"/>$3`);

const css = readFileSync("packages/js/browser/src/styles.css", "utf8");
writeFileSync("/private/tmp/claude-501/-Users-perls-workspace-openrecieve/d2e897fb-078f-49ec-b38a-fe423d7d1c4b/scratchpad/artifact-parts.json",
  JSON.stringify({ css, beforeHtml, afterHtml }, null, 2));
console.log("before bytes", beforeHtml.length, "after bytes", afterHtml.length);
console.log("qr injected (after):", afterHtml.includes("or-swap-qr\" src=\"data:"));
console.log("qr injected (before):", beforeHtml.includes("data-openreceive-qr") && beforeHtml.includes("data:image/svg"));
