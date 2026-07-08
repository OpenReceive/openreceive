import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Checkout } from "@openreceive/react";

const lightning = {
  invoice_id: "or_inv_lightning",
  rail: "lightning",
  invoice: "lnbc-display",
  payment_hash: "a".repeat(64),
  amount_msats: 19418000,
  transaction_state: "pending",
  workflow_state: "verifying",
  expires_at: Math.floor(Date.now() / 1000) + 583,
  fiat_quote: { fiat: { currency: "USD", value: "12.00" } },
};
const swap = {
  invoice_id: "or_inv_swap",
  rail: "swap",
  invoice: null,
  payment_hash: "b".repeat(64),
  amount_msats: 19418000,
  transaction_state: "pending",
  workflow_state: "invoice_created",
  expires_at: Math.floor(Date.now() / 1000) + 555,
  fiat_quote: { fiat: { currency: "USD", value: "12.00" } },
  swap: {
    attempt_id: "or_inv_swap",
    provider: "fixedfloat",
    provider_order_id: "ff-1",
    pay_in_asset: "USDT_SOL",
    deposit_address: "BispAWTSfhYBPtVMv98ZehKpBidK2s31akzu1ViEPxwz",
    deposit_amount: "12.21700000",
    provider_state: "awaiting_deposit",
    provider_expires_at: Math.floor(Date.now() / 1000) + 555,
  },
};
const checkout = {
  checkout_id: "or_chk_test",
  order_id: "order_test",
  status: "open",
  amount_msats: 19418000,
  fiat: { currency: "USD", value: "12.00" },
  active: lightning,
  invoices: [swap, lightning],
  payment_methods: [
    {
      pay_in_asset: "USDT_SOL",
      label: "USDT",
      network_label: "Solana",
      provider: "fixedfloat",
      available: true,
    },
  ],
};

const html = renderToStaticMarkup(
  React.createElement(Checkout, { checkout, polling: false })
);
console.log(html);
