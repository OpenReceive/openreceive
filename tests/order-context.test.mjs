// What the payer is buying. The shipped checkout renders the total and never
// the order — it cannot, because OpenReceive owns no line items — so a stock
// integration is a QR and "$1.00". These are the two affordances that fix that
// on the DEFAULT path: one display string from the host's amount hook, and a
// named slot for the host's own markup.
import assert from "node:assert/strict";
import test from "node:test";

process.env.LOG_LEVEL ??= "error";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createCheckoutState,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_SLOTS,
} from "@openreceive/browser/headless";
import { renderCheckoutHtml } from "@openreceive/elements";
import { Checkout } from "@openreceive/react";

const NOW = Math.floor(Date.now() / 1000);
const invoice = {
  invoice_id: "or_inv_desc",
  rail: "lightning",
  invoice: "lnbc-desc",
  payment_hash: "a".repeat(64),
  amount_msats: 200_000,
  transaction_state: "pending",
  workflow_state: "invoice_created",
  expires_at: NOW + 600,
};
const snapshot = (description) => ({
  checkout_id: "or_chk_desc",
  reference: "order-desc",
  status: "open",
  amount_msats: 200_000,
  active: invoice,
  invoices: [invoice],
  ...(description === undefined ? {} : { description }),
});

test("the description survives the snapshot -> state fold as data, not a label", () => {
  const state = createCheckoutState(snapshot("2 kg Ataulfo mangoes"), {
    now: NOW,
    logger: false,
  });
  assert.equal(state.description, "2 kg Ataulfo mangoes");
  assert.equal(createCheckoutState(snapshot(), { now: NOW, logger: false }).description, undefined);
});

test("both drop-ins render the description above the amount, outside the Lightning pane", () => {
  const html = renderCheckoutHtml({
    ...invoice,
    description: "2 kg Ataulfo mangoes",
    theme: "light",
  });
  assert.match(html, /2 kg Ataulfo mangoes/);
  assert.match(html, new RegExp(OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.orderDescription));
  // Above the payment layout, which drops out on the swap panel, on expiry and
  // on the receipt — the payer needs it on all four screens.
  assert.ok(
    html.indexOf("2 kg Ataulfo mangoes") < html.indexOf('part="payment-layout"'),
    "the description must render above the payment layout",
  );

  const react = renderToStaticMarkup(
    React.createElement(Checkout, { checkout: snapshot("2 kg Ataulfo mangoes"), polling: false }),
  );
  assert.match(react, /2 kg Ataulfo mangoes/);
  assert.match(react, new RegExp(OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.orderDescription));
});

test("no description means no element at all, in either renderer", () => {
  const html = renderCheckoutHtml({ ...invoice, theme: "light" });
  assert.doesNotMatch(html, new RegExp(OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.orderDescription));
  const react = renderToStaticMarkup(
    React.createElement(Checkout, { checkout: snapshot(), polling: false }),
  );
  assert.doesNotMatch(react, new RegExp(OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.orderDescription));
});

test("the element projects host order markup through a named slot", () => {
  // A <slot> in the shadow root, so light-DOM children the host wrote survive
  // every innerHTML re-render of the shell untouched. This is the element's
  // equivalent of React's render-prop `children`.
  const html = renderCheckoutHtml({ ...invoice, theme: "light" });
  assert.match(
    html,
    new RegExp(`<slot name="${OPENRECEIVE_CHECKOUT_ELEMENT_SLOTS.order}"></slot>`),
  );
  assert.equal(OPENRECEIVE_CHECKOUT_ELEMENT_SLOTS.order, "order");
});
