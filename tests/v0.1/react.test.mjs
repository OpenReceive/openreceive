import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CopyInvoiceButton,
  InvoiceSummary,
  OpenReceiveCheckout,
  OpenReceiveCopyButton,
  OpenReceiveInvoiceSummary,
  OpenReceiveOpenWalletButton,
  OpenReceivePaymentState,
  OpenWalletButton,
  PaymentState,
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
      }),
      props.paymentHashLabel
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
  assert.match(html, />Copy</);
  assert.match(html, /class="app-open"/);
  assert.match(html, />Open Wallet</);
  assert.doesNotMatch(html, /nostr\+walletconnect/);
});

test("React checkout render prop can replace default visible markup", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      OpenReceiveCheckout,
      {
        invoice: "lnbc-render-prop",
        amount_msats: 1000
      },
      (checkout) =>
        React.createElement(
          "p",
          {
            "data-custom-checkout": checkout.amountLabel
          },
          checkout.lightningUri
        )
    )
  );

  assert.match(html, /data-openreceive-checkout/);
  assert.match(html, /data-custom-checkout="1 sat"/);
  assert.match(html, />lightning:lnbc-render-prop</);
  assert.doesNotMatch(html, /aria-label="Lightning invoice"/);
});

test("React primitive aliases point to the stable components", () => {
  assert.equal(InvoiceSummary, OpenReceiveInvoiceSummary);
  assert.equal(CopyInvoiceButton, OpenReceiveCopyButton);
  assert.equal(OpenWalletButton, OpenReceiveOpenWalletButton);
  assert.equal(PaymentState, OpenReceivePaymentState);
});
