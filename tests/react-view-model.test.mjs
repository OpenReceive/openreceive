import assert from "node:assert/strict";
import test from "node:test";

// Browser checkout now auto-attaches a console logger at INFO; these unit tests
// do not assert that output, so keep the runner quiet unless explicitly overridden.
process.env.LOG_LEVEL ??= "error";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Checkout, createCheckoutViewModel } from "@openreceive/react";
import { invoice } from "./helpers/react-fixtures.mjs";

test("React checkout view model exposes display-safe actions", () => {
  const model = createCheckoutViewModel({
    checkout: invoice(),
  });

  assert.equal(model.lightning_uri, "lightning:lnbc-test");
  assert.equal(model.amountLabel, "200 sats");
  assert.equal(model.fiatLabel, "$0.05");
  assert.equal(model.paymentHashLabel, "aaaaaaaa...aaaaaaaa");
  assert.equal(model.status, "pending");
});

test("React checkout view model falls back to selected checkout amount labels", () => {
  const satsModel = createCheckoutViewModel({
    checkout: invoice({
      amount_msats: 500000,
      fiat: {
        currency: "SATS",
        value: "500",
      },
      fiat_quote: null,
    }),
  });
  const btcModel = createCheckoutViewModel({
    checkout: invoice({
      amount_msats: 500000,
      fiat: {
        currency: "BTC",
        value: "0.00000500",
      },
      fiat_quote: null,
    }),
  });

  assert.equal(satsModel.amountLabel, "500 sats");
  assert.equal(satsModel.fiatLabel, "500 sats");
  assert.equal(btcModel.amountLabel, "500 sats");
  assert.equal(btcModel.fiatLabel, "0.00000500 BTC");
});

test("React checkout rejects NWC strings before rendering", () => {
  assert.throws(
    () =>
      createCheckoutViewModel({
        checkout: invoice({
          invoice: `nostr+walletconnect://${"a".repeat(64)}?secret=${"b".repeat(64)}`,
        }),
      }),
    /must not be an NWC/,
  );
});

test("React checkout displays the Lightning invoice after a swap payment settles", () => {
  // A checkout paid via swap has no active invoice and its newest invoice is the settled
  // swap shadow, which carries no bolt11. The display must fall back to the payable
  // Lightning invoice instead of crashing. Regression for the post-swap checkout crash.
  const lightning = {
    invoice_id: "or_inv_display_swap",
    rail: "lightning",
    invoice: "lnbc-display-swap",
    payment_hash: "d".repeat(64),
    amount_msats: 19450000,
    transaction_state: "pending",
    workflow_state: "verifying",
    fiat_quote: null,
  };
  const settledShadow = {
    invoice_id: "or_inv_shadow_swap",
    rail: "swap",
    invoice: null,
    payment_hash: "e".repeat(64),
    amount_msats: 19450000,
    transaction_state: "settled",
    workflow_state: "paid",
    settled_at: 1783518782,
    fiat_quote: null,
  };
  const paidSwapCheckout = {
    checkout_id: "or_chk_paid_swap",
    reference: "order-paid-swap",
    status: "paid",
    paid_at: 1783518782,
    amount_msats: 19450000,
    invoices: [settledShadow, lightning],
  };

  const model = createCheckoutViewModel({ checkout: paidSwapCheckout });
  assert.equal(model.invoice_id, "or_inv_display_swap");
  assert.equal(model.invoice, "lnbc-display-swap");
  assert.equal(model.status, "settled");

  const html = renderToStaticMarkup(React.createElement(Checkout, { checkout: paidSwapCheckout }));
  assert.match(html, /data-openreceive-checkout/);
});

test("React checkout renders swap-only deferred checkouts without a Lightning invoice", () => {
  // Deferred Lightning + active/pending swap: public swap payloads omit bolt11. The
  // React view model must not throw; Lightning UI stays hidden until a bolt11 exists.
  const swapOnlyCheckout = {
    checkout_id: "or_chk_swap_only",
    reference: "order-swap-only",
    status: "open",
    amount_msats: 3028000,
    active: {
      invoice_id: "or_inv_swap_only",
      rail: "swap",
      invoice: null,
      payment_hash: "f".repeat(64),
      amount_msats: 3028000,
      transaction_state: "pending",
      workflow_state: "invoice_created",
      swap: {
        provider: "lightning-swap-com",
        provider_order_id: "2WGWRH",
        pay_in_asset: "SOL_SOL",
        deposit_address: "SoLAddress",
        deposit_amount: "0.027479",
        provider_state: "awaiting_deposit",
        provider_expires_at: Math.floor(Date.now() / 1000) + 600,
      },
    },
    invoices: [
      {
        invoice_id: "or_inv_swap_only",
        rail: "swap",
        invoice: null,
        payment_hash: "f".repeat(64),
        amount_msats: 3028000,
        transaction_state: "pending",
        workflow_state: "invoice_created",
        swap: {
          provider: "lightning-swap-com",
          provider_order_id: "2WGWRH",
          pay_in_asset: "SOL_SOL",
          deposit_address: "SoLAddress",
          deposit_amount: "0.027479",
          provider_state: "awaiting_deposit",
          provider_expires_at: Math.floor(Date.now() / 1000) + 600,
        },
      },
    ],
  };

  const model = createCheckoutViewModel({ checkout: swapOnlyCheckout });
  assert.equal(model.invoice, "");
  assert.equal(model.status, "pending");

  const settledCheckout = {
    ...swapOnlyCheckout,
    status: "paid",
    paid_at: 1784740424,
    active: undefined,
    invoices: [
      {
        ...swapOnlyCheckout.invoices[0],
        transaction_state: "settled",
        workflow_state: "paid",
        settled_at: 1784740424,
      },
    ],
  };
  const settledModel = createCheckoutViewModel({ checkout: settledCheckout });
  assert.equal(settledModel.status, "settled");
  assert.equal(settledModel.invoice, "");

  const html = renderToStaticMarkup(
    React.createElement(Checkout, { checkout: swapOnlyCheckout, polling: false }),
  );
  assert.match(html, /data-openreceive-checkout/);
  assert.doesNotMatch(html, /Bitcoin Lightning invoice/);
});
