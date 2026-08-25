import assert from "node:assert/strict";
import test from "node:test";

// Browser checkout now auto-attaches a console logger at INFO; these unit tests
// do not assert that output, so keep the runner quiet unless explicitly overridden.
process.env.LOG_LEVEL ??= "error";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Checkout, CheckoutProvider, PaymentState, useCheckoutContext } from "@openreceive/react";
import { invoice } from "./helpers/react-fixtures.mjs";

test("React checkout default UI server-renders display-safe invoice data", () => {
  const html = renderToStaticMarkup(
    React.createElement(Checkout, {
      checkout: invoice({
        payment_hash: "b".repeat(64),
        amount_msats: 1000,
        fiat_quote: undefined,
      }),
    }),
  );

  assert.match(html, /data-openreceive-checkout/);
  assert.match(html, /data-openreceive-theme="light"/);
  assert.match(html, /1 sat/);
  assert.match(html, /text-base-content\/60 text-sm leading-snug/);
  assert.match(html, /Bitcoin Lightning invoice/);
  assert.match(html, /Waiting for payment/);
  // Pending status is conveyed by WaitingState; avoid a redundant "pending" badge.
  assert.doesNotMatch(html, /data-openreceive-state="pending"/);
  assert.doesNotMatch(html, /bbbbbbbb\.\.\.bbbbbbbb/);
  assert.doesNotMatch(html, /textarea/);
  // The BOLT11 never appears: no decoder is configured, so there is no Decode
  // link, and the invoice is not visible text either.
  assert.doesNotMatch(html, /lnbc-test/);
  assert.match(html, /Copy invoice/);
  assert.doesNotMatch(html, />Decode</);
  assert.doesNotMatch(html, /rizful/);
  assert.doesNotMatch(html, /Open Wallet/);
  assert.doesNotMatch(html, /nostr\+walletconnect/);
});

test("React checkout default UI includes countdown, waiting state, and payment wizard", () => {
  const now = Math.floor(Date.now() / 1000);
  const html = renderToStaticMarkup(
    React.createElement(Checkout, {
      checkout: invoice({
        invoice_id: "or_inv_test",
        payment_hash: "b".repeat(64),
        amount_msats: 1000,
        fiat_quote: undefined,
        expires_at: now + 600,
      }),
    }),
  );

  assert.match(html, /Waiting for payment/);
  assert.match(html, /Invoice expires in/);
  assert.match(html, /Pay this invoice/);
  assert.match(html, /Bitcoin/);
  assert.match(html, /Loading currencies/);
  assert.doesNotMatch(html, />Crypto</);
  assert.doesNotMatch(html, /Credit Card/);
  assert.doesNotMatch(html, /Bank Transfer/);
  assert.doesNotMatch(html, /textarea/);
  assert.doesNotMatch(html, /lnbc-test/);
  assert.doesNotMatch(html, /or_inv_test/);
});

test("React checkout hides payable surfaces after invoice expiry", () => {
  const html = renderToStaticMarkup(
    React.createElement(Checkout, {
      checkout: invoice({
        invoice_id: "or_inv_expired",
        invoice: "lnbc-expired",
        payment_hash: "c".repeat(64),
        amount_msats: 1000,
        fiat_quote: undefined,
        expires_at: Math.floor(Date.now() / 1000) - 1,
      }),
    }),
  );

  assert.match(html, /Invoice expired/);
  assert.match(html, /Start over/);
  assert.doesNotMatch(html, /Invoice expires in/);
  assert.doesNotMatch(html, /data-openreceive-qr/);
  assert.doesNotMatch(html, /textarea/);
  assert.doesNotMatch(html, /Pay this invoice/);
  assert.doesNotMatch(html, /Copy invoice/);
});

test("React payment state primitive renders current state", () => {
  const html = renderToStaticMarkup(
    React.createElement(PaymentState, {
      state: "settled",
    }),
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
        "data-slot-qr": props.invoice,
      },
      "QR",
    );
  }

  function CustomPaymentState(props) {
    return React.createElement(
      "strong",
      {
        className: props.className,
        "data-slot-state": props.state,
      },
      props.state,
    );
  }

  function CustomSummary(props) {
    return React.createElement(
      "aside",
      {
        className: props.className,
        "data-slot-summary": "",
      },
      props.amountLabel,
      React.createElement(props.PaymentStateComponent, {
        state: props.status,
        className: props.classNames.paymentState,
      }),
    );
  }

  function CustomButton(props) {
    return React.createElement(
      "button",
      {
        className: props.className,
        type: props.type,
        "data-slot-button": "",
      },
      props.children,
    );
  }

  const componentSlots = {
    Button: CustomButton,
    QRCode: CustomQr,
    InvoiceSummary: CustomSummary,
    PaymentState: CustomPaymentState,
  };
  const classSlots = {
    root: "app-root",
    qr: "app-qr",
    summary: "app-summary",
    paymentState: "app-state",
    copyButton: "app-copy",
    openWalletButton: "app-open",
  };

  const html = renderToStaticMarkup(
    React.createElement(Checkout, {
      checkout: invoice({
        invoice: "lnbc-slot-test",
        payment_hash: "c".repeat(64),
        amount_msats: 200000,
        fiat_quote: undefined,
      }),
      components: componentSlots,
      classNames: classSlots,
    }),
  );

  assert.match(html, /app-root/);
  assert.match(html, /data-slot-qr="lnbc-slot-test"/);
  assert.match(html, /app-qr/);
  assert.match(html, /data-slot-button=""/);
  assert.match(html, /app-copy/);
  assert.match(html, />Copy invoice</);
  assert.doesNotMatch(html, /class="app-open"/);
  assert.doesNotMatch(html, />Open Wallet</);
  assert.doesNotMatch(html, /nostr\+walletconnect/);

  // Summary meta (and the PaymentState slot) only render for terminal statuses; settled
  // also swaps the paying affordances (QR / copy) for the transaction-details panel.
  const settledHtml = renderToStaticMarkup(
    React.createElement(Checkout, {
      checkout: invoice({
        invoice: "lnbc-slot-test",
        payment_hash: "c".repeat(64),
        amount_msats: 200000,
        fiat_quote: undefined,
        transaction_state: "settled",
        workflow_state: "paid",
        settled_at: 1_700_000_000,
      }),
      components: componentSlots,
      classNames: classSlots,
    }),
  );

  assert.match(settledHtml, /data-slot-summary=""/);
  assert.match(settledHtml, /app-summary/);
  assert.match(settledHtml, /data-slot-state="settled"/);
  assert.match(settledHtml, /app-state/);
  assert.doesNotMatch(settledHtml, /data-slot-qr/);
  assert.doesNotMatch(settledHtml, />Copy invoice</);
  // The settled panel is the SAME `TransactionDetails` the swap flow renders one
  // screen earlier, so the payer's receipt carries copy buttons rather than
  // un-copyable text — a payment hash is their whole evidence that they paid.
  assert.match(settledHtml, />Transaction details</);
  assert.match(settledHtml, /aria-label="Copy"/);
  assert.match(settledHtml, />Payment received</);
});

test("React checkout render prop can replace default visible markup", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      Checkout,
      {
        checkout: invoice({
          invoice_id: "or_inv_render_prop",
          invoice: "lnbc-render-prop",
          amount_msats: 1000,
          fiat_quote: undefined,
          workflow_state: "verifying",
          expires_at: 9999999999,
        }),
      },
      (checkout) =>
        React.createElement(
          "p",
          {
            "data-custom-checkout": checkout.amountLabel,
            "data-status": checkout.status,
            "data-countdown": checkout.countdownLabel,
          },
          checkout.lightning_uri,
          " ",
          checkout.countdownLabel,
        ),
    ),
  );

  assert.match(html, /data-openreceive-checkout/);
  assert.match(html, /data-custom-checkout="1 sat"/);
  assert.match(html, /data-status="pending"/);
  assert.match(html, /data-countdown=/);
  assert.match(html, />lightning:lnbc-render-prop /);
  assert.doesNotMatch(html, /aria-label="Lightning invoice"/);
});

test("React provider shares checkout state with a consumer hook", () => {
  function CheckoutConsumer() {
    const checkout = useCheckoutContext();
    return React.createElement(
      "strong",
      { "data-provider-amount": checkout.amountLabel },
      checkout.lightning_uri,
    );
  }

  const html = renderToStaticMarkup(
    React.createElement(
      CheckoutProvider,
      {
        checkout: invoice({
          invoice: "lnbc-provider-context",
          amount_msats: 1000,
          fiat_quote: undefined,
        }),
      },
      React.createElement(CheckoutConsumer),
    ),
  );

  assert.match(html, /data-provider-amount="1 sat"/);
  assert.match(html, />lightning:lnbc-provider-context</);
});

test("React provider render prop receives the controller-backed checkout model", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      CheckoutProvider,
      {
        checkout: invoice({
          invoice_id: "or_inv_provider_render",
          invoice: "lnbc-provider-render",
          amount_msats: 2000,
          fiat_quote: undefined,
        }),
      },
      (checkout) =>
        React.createElement(
          "span",
          {
            "data-provider-render": checkout.amountLabel,
            "data-provider-status": checkout.status,
            "data-provider-reload": typeof checkout.reloadState,
            "data-provider-retry": typeof checkout.retry,
            "data-provider-cancel": typeof checkout.cancel,
          },
          checkout.lightning_uri,
        ),
    ),
  );

  assert.match(html, /data-provider-render="2 sats"/);
  assert.match(html, /data-provider-status="pending"/);
  assert.match(html, /data-provider-reload="function"/);
  assert.match(html, /data-provider-retry="function"/);
  assert.match(html, /data-provider-cancel="function"/);
  assert.match(html, />lightning:lnbc-provider-render</);
});

test("React checkout context fails clearly outside the provider", () => {
  function CheckoutConsumer() {
    useCheckoutContext();
    return React.createElement("span", null, "never");
  }

  assert.throws(
    () => renderToStaticMarkup(React.createElement(CheckoutConsumer)),
    /CheckoutProvider/,
  );
});

test("React <Checkout reference> enters create mode and renders the creating placeholder", () => {
  // react-dom/server does not run effects, so the on-mount create POST is not observable from
  // an SSR render; the create -> POST { reference } -> poll /openreceive/payments/check
  // lifecycle is driven for real (happy-dom + real handler) in tests/lifecycle.test.mjs
  // (react-create surface) and tests/element-lifecycle.test.mjs. Here we assert the
  // component enters create mode and shows its minimal placeholder while pending.
  const html = renderToStaticMarkup(
    React.createElement(Checkout, { reference: "ord-1", prefix: "/openreceive" }),
  );
  assert.match(html, /openreceive-checkout-creating/);
  assert.match(html, /Creating checkout/);
  assert.doesNotMatch(html, />Copy invoice</);

  // A create with the default prefix (no prefix prop) also enters create mode.
  const defaultPrefixHtml = renderToStaticMarkup(
    React.createElement(Checkout, { reference: "ord-2" }),
  );
  assert.match(defaultPrefixHtml, /openreceive-checkout-creating/);
});

test("React <Checkout checkout> renders a supplied snapshot", () => {
  const html = renderToStaticMarkup(
    React.createElement(Checkout, { checkout: invoice(), prefix: "/openreceive" }),
  );
  assert.match(html, /data-openreceive-checkout/);
  assert.match(html, />Copy invoice</);
  assert.doesNotMatch(html, /openreceive-checkout-creating/);
});
