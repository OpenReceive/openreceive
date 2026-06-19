import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OpenReceiveCheckout,
  OpenReceivePaymentState,
  createOpenReceiveCheckoutViewModel
} from "@openreceive/react";

test("React checkout view model exposes display-safe actions", () => {
  const model = createOpenReceiveCheckoutViewModel({
    invoice: "lnbc-test",
    payment_hash: "a".repeat(64),
    amount_msats: 200000,
    transaction_state: "pending"
  });

  assert.equal(model.lightningUri, "lightning:lnbc-test");
  assert.equal(model.amountLabel, "200 sats");
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
  assert.match(html, /1 sat/);
  assert.match(html, /pending/);
  assert.match(html, /bbbbbbbb\.\.\.bbbbbbbb/);
  assert.match(html, /Copy/);
  assert.match(html, /Open Wallet/);
  assert.doesNotMatch(html, /nostr\+walletconnect/);
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
