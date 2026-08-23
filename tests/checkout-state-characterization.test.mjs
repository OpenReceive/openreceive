// Characterization of the checkout DISPLAY TRUTH for eight fixtures.
//
// A payment screen is rendered from a CheckoutSnapshot. There used to be two
// code paths that did that, written independently and disagreeing in four
// payer-visible places:
//
//   react path    createCheckoutViewModel(...)  =  toCheckoutDisplayData
//                                                  -> createCheckoutDisplayModel
//                                                  -> toCheckoutViewModel
//   browser path  createCheckoutState(snapshot, { now })
//
// Track G4 merged them and this wave deleted all three react functions, so
// there is now exactly ONE derivation — `createCheckoutState` — and the react
// model is that state plus a single extra field:
//
//   createCheckoutViewModel({ checkout })
//     = createCheckoutState(checkout) + { status: deriveCheckoutOrderStatus(checkout) }
//
// `status` is the coarse status of the whole CHECKOUT (pending / settled /
// expired / failed), not of the displayed attempt: a checkout paid by swap has
// a settled shadow attempt next to a still-pending Lightning one, and the payer
// must be told the order is paid. That is why each fixture below spells the
// browser state out field by field and then calls `assertReactModelMatches` —
// the react side is pinned as an EQUALITY against the browser state rather than
// as a second copy of the same values, which is precisely the property the
// merge bought and the property a future edit could quietly lose.
//
// The four divergences are gone, but the tests that found them stay, because
// each was closed by a deliberate decision about what the payer should see, and
// a decision that is not pinned gets undone. The four `RECONCILED` tests at the
// bottom of this file record which side won:
//
//   (a) fiat fallback        REACT WON. A missing/null attempt `fiat_quote`
//                            falls back to the checkout's own `fiat`. The
//                            browser used to forward the attempt's null, so the
//                            fiat line vanished from every swap screen.
//   (b) amount fallback      BROWSER WON. An attempt with no `amount_msats`
//                            falls back to the checkout's amount, which is what
//                            is owed. React used to render no amount at all.
//   (c) missing-bolt11 error REACT WON. The TypeError reads "OpenReceive
//                            checkout requires a display Lightning invoice."
//                            The browser's old wording blamed a "response" that
//                            an in-memory snapshot never had.
//   (d) swap lightning_uri   BROWSER WON. A swap attempt gets no `lightning:`
//                            URI even when it carries a bolt11, because a swap
//                            is paid at the deposit address and a wallet jump
//                            sends the payer down the wrong rail.
//
// Every expectation below is therefore one of two things: a value both paths
// already agreed on before the merge, or a value the merge deliberately moved.
// Every moved value carries a comment naming the move — `PRODUCT CHANGE` where
// a payer-visible value changed, `G4a` for the labels that moved onto
// CheckoutState. Any later change to any expectation here must be just as
// deliberate and just as labelled.
//
// `now` is anchored to the real clock because the react entry point still has
// no injectable one: `createCheckoutViewModel` calls `createCheckoutState`
// without a `now`, and `deriveCheckoutOrderStatus` reads the wall clock to
// decide "expired". Every asserted value is therefore expressed relative to
// NOW, never as an absolute.

import assert from "node:assert/strict";
import test from "node:test";

// The browser checkout attaches a console logger at INFO; these unit tests do
// not assert that output.
process.env.LOG_LEVEL ??= "error";

import {
  createCheckoutState,
  createCheckoutStatusModel,
  createOpenReceivePaymentDataEntries,
  createOpenReceiveTransactionDetailsFromState,
  formatOpenReceiveUnixTime,
} from "@openreceive/browser/headless";
import { renderCheckoutHtml } from "@openreceive/elements";
import { Checkout, createCheckoutViewModel } from "@openreceive/react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const NOW = Math.floor(Date.now() / 1000);
const hash = (character) => character.repeat(64);
// PRODUCT CHANGE: the payment-data panel used to print unix seconds with a
// ".000Z" the transaction-details panel next to it stripped. Both now render
// through the one display boundary (`optionalUnixTimeLabel`), so both print the
// stripped form. The milliseconds of a unix-SECONDS value are always zero, so
// the two labels never carried different information — only different noise.
const iso = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The browser path, with the clock pinned and logging off. */
const browserState = (snapshot) => createCheckoutState(snapshot, { now: NOW, logger: false });
/** The react path: the one derivation, plus the coarse checkout status. */
const reactModel = (snapshot) => createCheckoutViewModel({ checkout: snapshot });

// ---------------------------------------------------------------- fixtures --

const lightningInvoice = {
  invoice_id: "or_inv_ln_pending",
  invoice: "lnbc-pending",
  rail: "lightning",
  payment_hash: hash("a"),
  amount_msats: 200_000,
  fiat_quote: { fiat: { currency: "USD", value: "0.05" } },
  transaction_state: "pending",
  workflow_state: "invoice_created",
  expires_at: NOW + 600,
};
const lightningPending = {
  checkout_id: "or_chk_ln_pending",
  order_id: "order-ln-pending",
  status: "open",
  amount_msats: 200_000,
  fiat: { currency: "USD", value: "0.05" },
  active: lightningInvoice,
  invoices: [lightningInvoice],
};

const settledLightningInvoice = {
  invoice_id: "or_inv_ln_settled",
  invoice: "lnbc-settled",
  rail: "lightning",
  payment_hash: hash("b"),
  amount_msats: 200_000,
  fiat_quote: { fiat: { currency: "USD", value: "0.05" } },
  transaction_state: "settled",
  workflow_state: "paid",
  expires_at: NOW + 600,
  settled_at: NOW - 30,
};
const lightningSettled = {
  checkout_id: "or_chk_ln_settled",
  order_id: "order-ln-settled",
  status: "paid",
  paid_at: NOW - 30,
  amount_msats: 200_000,
  fiat: { currency: "USD", value: "0.05" },
  invoices: [settledLightningInvoice],
};

const expiredLightningInvoice = {
  invoice_id: "or_inv_ln_expired",
  invoice: "lnbc-expired",
  rail: "lightning",
  payment_hash: hash("c"),
  amount_msats: 200_000,
  fiat_quote: { fiat: { currency: "USD", value: "0.05" } },
  transaction_state: "pending",
  workflow_state: "invoice_created",
  expires_at: NOW - 600,
};
const lightningExpired = {
  checkout_id: "or_chk_ln_expired",
  order_id: "order-ln-expired",
  status: "open",
  amount_msats: 200_000,
  fiat: { currency: "USD", value: "0.05" },
  active: expiredLightningInvoice,
  invoices: [expiredLightningInvoice],
};

// Public swap payloads omit bolt11 and carry `fiat_quote: null`; the checkout's
// own `fiat` is the only fiat the payer can be shown. That is the case
// divergence (a) was about, and the reason the fallback it settled on matters.
const swapAttempt = {
  invoice_id: "or_inv_swap_pending",
  invoice: null,
  rail: "swap",
  payment_hash: hash("d"),
  amount_msats: 3_028_000,
  fiat_quote: null,
  transaction_state: "pending",
  workflow_state: "invoice_created",
  expires_at: NOW + 900,
  swap: {
    provider: "lightning-swap-com",
    provider_order_id: "2WGWRH",
    attempt_id: "or_att_swap",
    pay_in_asset: "SOL_SOL",
    deposit_address: "SoLAddress",
    deposit_amount: "0.027479",
    provider_state: "awaiting_deposit",
    provider_expires_at: NOW + 900,
  },
};
const swapPending = {
  checkout_id: "or_chk_swap_pending",
  order_id: "order-swap-pending",
  status: "open",
  amount_msats: 3_028_000,
  fiat: { currency: "USD", value: "2.10" },
  active: swapAttempt,
  invoices: [swapAttempt],
};

const settledSwapAttempt = {
  ...swapAttempt,
  invoice_id: "or_inv_swap_settled",
  transaction_state: "settled",
  workflow_state: "paid",
  settled_at: NOW - 45,
  swap: {
    ...swapAttempt.swap,
    provider_state: "completed",
    deposit_tx_id: "deposit-tx",
    payout_tx_id: "payout-tx",
  },
};
const swapSettled = {
  checkout_id: "or_chk_swap_settled",
  order_id: "order-swap-settled",
  status: "paid",
  paid_at: NOW - 45,
  amount_msats: 3_028_000,
  fiat: { currency: "USD", value: "2.10" },
  invoices: [settledSwapAttempt],
};

// `refund_required` is deliberately NOT a terminal provider state (the payer can
// still supply a refund address), so the state must stay non-terminal and keep
// polling. See isTerminalSwapProviderState.
const refundSwapAttempt = {
  ...swapAttempt,
  invoice_id: "or_inv_swap_refund",
  swap: {
    ...swapAttempt.swap,
    provider_state: "refund_required",
    refund_reason: "deposit below minimum",
    refund_amount: "0.027000",
    deposit_received_amount: "0.027479",
    deposit_tx_id: "deposit-tx-refund",
  },
};
const swapRefundRequired = {
  checkout_id: "or_chk_swap_refund",
  order_id: "order-swap-refund",
  status: "open",
  amount_msats: 3_028_000,
  fiat: { currency: "USD", value: "2.10" },
  active: refundSwapAttempt,
  invoices: [refundSwapAttempt],
};

const checkoutLockAttempt = {
  invoice_id: "or_inv_lock",
  invoice: null,
  rail: "checkout_lock",
  amount_msats: 750_000,
  transaction_state: "pending",
  workflow_state: "invoice_created",
};
const checkoutLockDeferred = {
  checkout_id: "or_chk_lock",
  order_id: "order-lock",
  status: "open",
  amount_msats: 750_000,
  fiat: { currency: "USD", value: "0.19" },
  active: checkoutLockAttempt,
  invoices: [checkoutLockAttempt],
};

// Paid via swap, with the payable Lightning attempt still alongside it: the
// newest attempt is the settled swap shadow (no bolt11), so the display must
// fall back to the Lightning attempt for QR/copy while reporting settlement.
const siblingLightning = {
  invoice_id: "or_inv_sibling_ln",
  invoice: "lnbc-sibling",
  rail: "lightning",
  payment_hash: hash("e"),
  amount_msats: 19_450_000,
  fiat_quote: null,
  transaction_state: "pending",
  workflow_state: "verifying",
  expires_at: NOW + 300,
};
const siblingSwapShadow = {
  invoice_id: "or_inv_sibling_swap",
  invoice: null,
  rail: "swap",
  payment_hash: hash("f"),
  amount_msats: 19_450_000,
  fiat_quote: null,
  transaction_state: "settled",
  workflow_state: "paid",
  settled_at: NOW - 10,
  swap: {
    provider: "lightning-swap-com",
    provider_order_id: "SIB123",
    pay_in_asset: "USDT_TRON",
    deposit_address: "TrxAddress",
    deposit_amount: "19.45",
    provider_state: "completed",
  },
};
const paidWithSiblingAttempts = {
  checkout_id: "or_chk_siblings",
  order_id: "order-siblings",
  status: "paid",
  paid_at: NOW - 10,
  amount_msats: 19_450_000,
  fiat: { currency: "USD", value: "19.45" },
  invoices: [siblingSwapShadow, siblingLightning],
};

// --------------------------------------------------------------- assertions --

/**
 * Both paths now run the SAME derivation, so the react model must be exactly the
 * browser state plus the coarse checkout status. That equality is the point of
 * G4; asserting it here is stronger than restating the values a second time.
 *
 * `expires_in_seconds` is the one field that cannot be compared verbatim:
 * `createCheckoutViewModel` has no injectable clock, so it recomputes the
 * countdown at call time and may land a second later than the pinned `now`.
 */
function assertReactModelMatches(snapshot, state, status) {
  const { expires_in_seconds: modelCountdown, ...model } = reactModel(snapshot);
  const { expires_in_seconds: stateCountdown, ...rest } = state;
  assert.deepStrictEqual(model, { ...rest, status });
  if (stateCountdown === undefined) {
    assert.equal(modelCountdown, undefined);
  } else {
    assert.ok(
      Math.abs(modelCountdown - stateCountdown) <= 2,
      `countdown ${modelCountdown} is not within 2s of ${stateCountdown}`,
    );
  }
}

// --------------------------------------------------------- 1. lightning pending

test("characterization: lightning pending", () => {
  const state = browserState(lightningPending);
  assert.deepStrictEqual(state, {
    checkout_id: "or_chk_ln_pending",
    order_id: "order-ln-pending",
    invoice_id: "or_inv_ln_pending",
    invoice: "lnbc-pending",
    rail: "lightning",
    lightning_uri: "lightning:lnbc-pending",
    // G4a: the labels moved onto CheckoutState (and so onto the
    // `openreceive-state` CustomEvent's detail.state).
    amountLabel: "200 sats",
    fiatLabel: "$0.05",
    paymentHashLabel: "aaaaaaaa...aaaaaaaa",
    payment_hash: hash("a"),
    amount_msats: 200_000,
    fiat_quote: { fiat: { currency: "USD", value: "0.05" } },
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: NOW + 600,
    paid: false,
    phase: "invoice_created",
    settled: false,
    terminal: false,
    expires_in_seconds: 600,
  });
  assertReactModelMatches(lightningPending, state, "pending");

  assert.deepStrictEqual(createCheckoutStatusModel(state, { now: NOW }), {
    phase: "invoice_created",
    waiting: true,
    title: "Waiting for payment",
    detail: "Keep this page open while we verify settlement.",
    countdownPrefix: "Invoice expires in",
    expires_in_seconds: 600,
    countdownLabel: "10:00",
  });

  assert.deepStrictEqual(createOpenReceivePaymentDataEntries(state), [
    { label: "Order", value: "order-ln-pending" },
    { label: "Checkout", value: "or_chk_ln_pending" },
    { label: "Invoice ID", value: "or_inv_ln_pending" },
    { label: "Payment hash", value: hash("a") },
    { label: "Amount", value: "200 sats (200000 msats)" },
    { label: "Fiat amount", value: "0.05 USD" },
    { label: "Rail", value: "lightning" },
    { label: "Transaction state", value: "pending" },
    { label: "Workflow state", value: "invoice_created" },
    { label: "Invoice expires at", value: iso(NOW + 600) },
    { label: "BOLT11 invoice", value: "lnbc-pending" },
  ]);
});

// --------------------------------------------------------- 2. lightning settled

test("characterization: lightning settled", () => {
  const state = browserState(lightningSettled);
  assert.deepStrictEqual(state, {
    checkout_id: "or_chk_ln_settled",
    order_id: "order-ln-settled",
    invoice_id: "or_inv_ln_settled",
    invoice: "lnbc-settled",
    rail: "lightning",
    lightning_uri: "lightning:lnbc-settled",
    amountLabel: "200 sats",
    fiatLabel: "$0.05",
    paymentHashLabel: "bbbbbbbb...bbbbbbbb",
    payment_hash: hash("b"),
    amount_msats: 200_000,
    fiat_quote: { fiat: { currency: "USD", value: "0.05" } },
    transaction_state: "settled",
    workflow_state: "paid",
    expires_at: NOW + 600,
    settled_at: NOW - 30,
    paid: true,
    phase: "settled",
    settled: true,
    terminal: false,
    expires_in_seconds: 600,
  });
  assertReactModelMatches(lightningSettled, state, "settled");

  // No countdown once settled — the invoice's remaining lifetime is meaningless
  // to a payer whose payment already landed.
  assert.deepStrictEqual(createCheckoutStatusModel(state, { now: NOW }), {
    phase: "settled",
    waiting: false,
    title: "Payment received",
    detail: "Backend settlement verified.",
    countdownPrefix: "Invoice expires in",
  });
});

// --------------------------------------------------------- 3. lightning expired

test("characterization: lightning expired", () => {
  const state = browserState(lightningExpired);
  assert.deepStrictEqual(state, {
    checkout_id: "or_chk_ln_expired",
    order_id: "order-ln-expired",
    invoice_id: "or_inv_ln_expired",
    invoice: "lnbc-expired",
    rail: "lightning",
    lightning_uri: "lightning:lnbc-expired",
    amountLabel: "200 sats",
    fiatLabel: "$0.05",
    paymentHashLabel: "cccccccc...cccccccc",
    payment_hash: hash("c"),
    amount_msats: 200_000,
    fiat_quote: { fiat: { currency: "USD", value: "0.05" } },
    // The attempt itself still says "pending": expiry is derived from the clock,
    // not from a wire field, and only the phase reports it.
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: NOW - 600,
    paid: false,
    phase: "expired",
    settled: false,
    terminal: true,
    expires_in_seconds: 0,
  });
  assertReactModelMatches(lightningExpired, state, "expired");

  assert.deepStrictEqual(createCheckoutStatusModel(state, { now: NOW }), {
    phase: "expired",
    waiting: false,
    title: "Invoice expired",
    detail: "Create a fresh invoice to keep going.",
    countdownPrefix: "Invoice expires in",
  });
});

// -------------------------------------------------------------- 4. swap pending

test("characterization: swap pending", () => {
  const state = browserState(swapPending);
  assert.deepStrictEqual(state, {
    checkout_id: "or_chk_swap_pending",
    order_id: "order-swap-pending",
    invoice_id: "or_inv_swap_pending",
    invoice: "",
    rail: "swap",
    lightning_uri: "",
    amountLabel: "3,028 sats",
    // PRODUCT CHANGE (divergence (a)): the browser path used to pass the
    // attempt's null straight through and the payer lost the fiat line. It now
    // falls back to the checkout's own fiat, as the react path always did.
    fiatLabel: "$2.10",
    paymentHashLabel: "dddddddd...dddddddd",
    payment_hash: hash("d"),
    amount_msats: 3_028_000,
    fiat_quote: { fiat: { currency: "USD", value: "2.10" } },
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: NOW + 900,
    swap: swapAttempt.swap,
    paid: false,
    phase: "invoice_created",
    settled: false,
    terminal: false,
    expires_in_seconds: 900,
  });
  assertReactModelMatches(swapPending, state, "pending");

  assert.deepStrictEqual(createOpenReceivePaymentDataEntries(state), [
    { label: "Order", value: "order-swap-pending" },
    { label: "Checkout", value: "or_chk_swap_pending" },
    { label: "Invoice ID", value: "or_inv_swap_pending" },
    { label: "Payment hash", value: hash("d") },
    { label: "Amount", value: "3,028 sats (3028000 msats)" },
    // PRODUCT CHANGE (divergence (a)): this row was missing from the browser
    // path's payment-data panel for every swap.
    { label: "Fiat amount", value: "2.10 USD" },
    { label: "Rail", value: "swap" },
    { label: "Transaction state", value: "pending" },
    { label: "Workflow state", value: "invoice_created" },
    { label: "Invoice expires at", value: iso(NOW + 900) },
    { label: "Swap provider", value: "lightning-swap-com" },
    { label: "Swap pay-in asset", value: "SOL_SOL" },
    { label: "Swap provider order", value: "2WGWRH" },
    { label: "Swap state", value: "awaiting_deposit" },
  ]);
});

// -------------------------------------------------------------- 5. swap settled

test("characterization: swap settled", () => {
  const state = browserState(swapSettled);
  assert.deepStrictEqual(state, {
    checkout_id: "or_chk_swap_settled",
    order_id: "order-swap-settled",
    invoice_id: "or_inv_swap_settled",
    invoice: "",
    rail: "swap",
    lightning_uri: "",
    amountLabel: "3,028 sats",
    fiatLabel: "$2.10",
    paymentHashLabel: "dddddddd...dddddddd",
    payment_hash: hash("d"),
    amount_msats: 3_028_000,
    fiat_quote: { fiat: { currency: "USD", value: "2.10" } },
    transaction_state: "settled",
    workflow_state: "paid",
    expires_at: NOW + 900,
    settled_at: NOW - 45,
    swap: settledSwapAttempt.swap,
    paid: true,
    phase: "settled",
    settled: true,
    terminal: false,
    expires_in_seconds: 900,
  });
  assertReactModelMatches(swapSettled, state, "settled");

  assert.deepStrictEqual(createOpenReceivePaymentDataEntries(state), [
    { label: "Order", value: "order-swap-settled" },
    { label: "Checkout", value: "or_chk_swap_settled" },
    { label: "Invoice ID", value: "or_inv_swap_settled" },
    { label: "Payment hash", value: hash("d") },
    { label: "Amount", value: "3,028 sats (3028000 msats)" },
    { label: "Fiat amount", value: "2.10 USD" },
    { label: "Rail", value: "swap" },
    { label: "Transaction state", value: "settled" },
    { label: "Workflow state", value: "paid" },
    { label: "Settled at", value: iso(NOW - 45) },
    { label: "Invoice expires at", value: iso(NOW + 900) },
    { label: "Swap provider", value: "lightning-swap-com" },
    { label: "Swap pay-in asset", value: "SOL_SOL" },
    { label: "Swap provider order", value: "2WGWRH" },
    { label: "Swap state", value: "completed" },
    { label: "Swap deposit tx", value: "deposit-tx" },
    { label: "Swap payout tx", value: "payout-tx" },
  ]);
});

// ------------------------------------------------------ 6. swap refund_required

test("characterization: swap refund_required", () => {
  const state = browserState(swapRefundRequired);
  assert.deepStrictEqual(state, {
    checkout_id: "or_chk_swap_refund",
    order_id: "order-swap-refund",
    invoice_id: "or_inv_swap_refund",
    invoice: "",
    rail: "swap",
    lightning_uri: "",
    amountLabel: "3,028 sats",
    fiatLabel: "$2.10",
    paymentHashLabel: "dddddddd...dddddddd",
    payment_hash: hash("d"),
    amount_msats: 3_028_000,
    fiat_quote: { fiat: { currency: "USD", value: "2.10" } },
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: NOW + 900,
    swap: refundSwapAttempt.swap,
    paid: false,
    phase: "invoice_created",
    settled: false,
    // NOT terminal: the payer can still supply a refund address, so watchers
    // must keep polling.
    terminal: false,
    expires_in_seconds: 900,
  });
  assertReactModelMatches(swapRefundRequired, state, "pending");
});

// ---------------------------------------------------- 7. checkout_lock deferred

test("characterization: checkout_lock deferred", () => {
  // No bolt11 has been minted. Both paths return a minimal stub with empty
  // invoice strings; callers gate all bolt11-dependent UI on that.
  const state = browserState(checkoutLockDeferred);
  assert.deepStrictEqual(state, {
    checkout_id: "or_chk_lock",
    order_id: "order-lock",
    invoice_id: "",
    invoice: "",
    rail: "checkout_lock",
    lightning_uri: "",
    amountLabel: "750 sats",
    fiatLabel: "$0.19",
    amount_msats: 750_000,
    // The deferred branch always fell back to the checkout's own fiat; the
    // flattening branch now does too.
    fiat_quote: { fiat: { currency: "USD", value: "0.19" } },
    transaction_state: "pending",
    workflow_state: "invoice_created",
    phase: "invoice_created",
    settled: false,
    terminal: false,
    paid: false,
  });
  assertReactModelMatches(checkoutLockDeferred, state, "pending");

  assert.deepStrictEqual(createOpenReceivePaymentDataEntries(state), [
    { label: "Order", value: "order-lock" },
    { label: "Checkout", value: "or_chk_lock" },
    { label: "Amount", value: "750 sats (750000 msats)" },
    { label: "Fiat amount", value: "0.19 USD" },
    { label: "Rail", value: "checkout_lock" },
    { label: "Transaction state", value: "pending" },
    { label: "Workflow state", value: "invoice_created" },
  ]);
});

// ------------------------------------------- 8. paid, with sibling attempts

test("characterization: paid with sibling attempts", () => {
  const state = browserState(paidWithSiblingAttempts);
  assert.deepStrictEqual(state, {
    checkout_id: "or_chk_siblings",
    order_id: "order-siblings",
    // The displayed attempt is the payable Lightning one, not the settled swap
    // shadow that has no bolt11.
    invoice_id: "or_inv_sibling_ln",
    invoice: "lnbc-sibling",
    rail: "lightning",
    lightning_uri: "lightning:lnbc-sibling",
    amountLabel: "19,450 sats",
    fiatLabel: "$19.45",
    paymentHashLabel: "eeeeeeee...eeeeeeee",
    payment_hash: hash("e"),
    amount_msats: 19_450_000,
    fiat_quote: { fiat: { currency: "USD", value: "19.45" } },
    // The CHECKOUT is paid, so the state overrides the displayed attempt's own
    // pending/verifying pair. PRODUCT CHANGE for React's payment-data panel,
    // which used to print the attempt's states on a checkout already paid.
    transaction_state: "settled",
    workflow_state: "paid",
    expires_at: NOW + 300,
    // The checkout's paid_at wins over the displayed attempt's settled_at.
    settled_at: NOW - 10,
    paid: true,
    phase: "settled",
    settled: true,
    terminal: false,
    expires_in_seconds: 300,
  });
  assertReactModelMatches(paidWithSiblingAttempts, state, "settled");
});

// ------------------------------ the four divergences (a)-(d), and how each ended
//
// Each test names the losing behaviour in the past tense and asserts the winner
// on BOTH paths, so it fails if either path drifts back.

test("divergence (a) RECONCILED: fiat falls back to the checkout's own quote", () => {
  // PRODUCT CHANGE for the browser path. react resolved three ways WITH a
  // snapshot.fiat fallback; the browser passed the attempt's null straight
  // through. The react resolution wins — without it the fiat label silently
  // disappears from a swap payment screen. tests/react-view-model.test.mjs pins
  // the same rule from the react side ('500 sats' / '0.00000500 BTC').
  const expected = { fiat: { currency: "USD", value: "2.10" } };
  assert.deepStrictEqual(reactModel(swapPending).fiat_quote, expected);
  assert.equal(reactModel(swapPending).fiatLabel, "$2.10");
  assert.deepStrictEqual(browserState(swapPending).fiat_quote, expected);
  assert.equal(browserState(swapPending).fiatLabel, "$2.10");

  // With no checkout-level fiat either, the null is dropped rather than
  // forwarded: there is nothing to show, and `undefined` is what "no fiat"
  // means everywhere else in the state.
  const noFiatAnywhere = { ...swapPending, fiat: undefined };
  assert.equal(browserState(noFiatAnywhere).fiat_quote, undefined);
  assert.equal(browserState(noFiatAnywhere).fiatLabel, undefined);
});

test("divergence (b) RECONCILED: amount_msats falls back to the checkout amount", () => {
  const invoiceWithoutAmount = {
    invoice_id: "or_inv_b",
    invoice: "lnbc-b",
    rail: "lightning",
    transaction_state: "pending",
    workflow_state: "invoice_created",
  };
  const snapshot = {
    checkout_id: "or_chk_b",
    order_id: "order-b",
    status: "open",
    amount_msats: 123_000,
    active: invoiceWithoutAmount,
    invoices: [invoiceWithoutAmount],
  };
  // PRODUCT CHANGE for the react path. The browser path had
  // `?? snapshot.amount_msats`; react did not, so it rendered NO amount at all
  // for an attempt that omits its own. The checkout's amount is what is owed, so
  // the browser rule wins.
  assert.equal(browserState(snapshot).amount_msats, 123_000);
  assert.equal(browserState(snapshot).amountLabel, "123 sats");
  assert.equal(reactModel(snapshot).amount_msats, 123_000);
  assert.equal(reactModel(snapshot).amountLabel, "123 sats");
});

test("divergence (c) RECONCILED: the missing-bolt11 TypeError message", () => {
  const invoiceWithoutBolt11 = {
    invoice_id: "or_inv_c",
    invoice: null,
    rail: "lightning",
    transaction_state: "pending",
    workflow_state: "invoice_created",
  };
  const snapshot = {
    checkout_id: "or_chk_c",
    order_id: "order-c",
    status: "open",
    amount_msats: 1_000,
    active: invoiceWithoutBolt11,
    invoices: [invoiceWithoutBolt11],
  };
  // PRODUCT CHANGE for the browser path: it used to say "OpenReceive checkout
  // response requires invoice.", which is a lie whenever the snapshot came from
  // memory rather than a response. React's display-shaped message wins.
  const message = "OpenReceive checkout requires a display Lightning invoice.";
  assert.throws(() => reactModel(snapshot), { name: "TypeError", message });
  assert.throws(() => browserState(snapshot), { name: "TypeError", message });
});

test("divergence (d) RECONCILED: no lightning_uri on a swap attempt", () => {
  const swapWithBolt11 = {
    invoice_id: "or_inv_d",
    invoice: "lnbc-swap",
    rail: "swap",
    amount_msats: 5_000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    swap: { provider: "p", pay_in_asset: "BTC", provider_state: "awaiting_deposit" },
  };
  const snapshot = {
    checkout_id: "or_chk_d",
    order_id: "order-d",
    status: "open",
    amount_msats: 5_000,
    active: swapWithBolt11,
    invoices: [swapWithBolt11],
  };
  // PRODUCT CHANGE for the react path, which used to hand back
  // "lightning:lnbc-swap". A swap is paid at the deposit address, so a wallet
  // jump on that screen sends the payer down the wrong rail; the browser's
  // blanking rule wins. Both still keep the bolt11 itself in `invoice` for
  // anything that legitimately needs it. Public swap payloads omit bolt11, so
  // this case is not reachable from the wire today — it is the rule that
  // matters, not the frequency.
  assert.equal(reactModel(snapshot).invoice, "lnbc-swap");
  assert.equal(reactModel(snapshot).lightning_uri, "");
  assert.equal(browserState(snapshot).invoice, "lnbc-swap");
  assert.equal(browserState(snapshot).lightning_uri, "");
});

// --------------------------------------------- a malformed amount is one row --

// `formatOpenReceiveMsats` throws on a negative, fractional or unsafe amount —
// correctly, because it is the FORMATTER the wire builders and the amount
// validators share. Every DISPLAY site therefore goes through the optional
// wrapper instead, so a server answering with a nonsense `amount_msats` costs
// exactly the row that would have shown the formatted amount and nothing else.
// The raw value still rides on the state, and every panel still shows it under
// its own "Amount (msats)" row, because support needs to see what was actually
// received.
//
// The poll loop calls `createCheckoutState` on every status result, and the
// SETTLED screen adds two more projections on top of it (the payment-data panel
// and the transaction-details rows) that a pending screen never renders. All of
// them are covered here, on all three rails, because a bad amount arriving after
// settlement is exactly when the payer has already parted with their money.
const NONSENSE_AMOUNTS = [-1, 1.5, Number.MAX_SAFE_INTEGER + 2];
const RAILS = ["lightning", "swap", "checkout_lock"];

function nonsenseAmountSnapshot({ rail, settled, amountMsats }) {
  const attempt = {
    invoice_id: `or_inv_bad_${rail}`,
    // Only the Lightning rail requires a display bolt11; swap and checkout_lock
    // attempts legitimately carry none.
    invoice: rail === "lightning" ? "lnbc-bad-amount" : null,
    rail,
    payment_hash: hash("e"),
    amount_msats: amountMsats,
    transaction_state: settled ? "settled" : "pending",
    workflow_state: settled ? "paid" : "invoice_created",
    ...(settled ? { settled_at: NOW - 10 } : {}),
    ...(rail === "swap"
      ? {
          swap: {
            provider: "lightning-swap-com",
            pay_in_asset: "SOL_SOL",
            deposit_address: "SoLAddress",
            deposit_amount: "0.027479",
            provider_state: settled ? "completed" : "awaiting_deposit",
          },
        }
      : {}),
  };
  return {
    checkout_id: `or_chk_bad_${rail}`,
    order_id: `order-bad-${rail}`,
    status: settled ? "paid" : "open",
    ...(settled ? { paid_at: NOW - 10 } : {}),
    amount_msats: amountMsats,
    ...(settled ? {} : { active: attempt }),
    invoices: [attempt],
  };
}

/** The value of the row with this label, or undefined when no such row exists. */
const rowValue = (rows, label) => rows.find((row) => row.label === label)?.value;

test("a nonsense amount costs the label, not the payment screen", () => {
  for (const amountMsats of NONSENSE_AMOUNTS) {
    for (const rail of RAILS) {
      for (const settled of [false, true]) {
        const where = `${rail}/${settled ? "settled" : "pending"}/${amountMsats}`;
        const snapshot = nonsenseAmountSnapshot({ rail, settled, amountMsats });

        // 1. The state itself: raw amount kept, label blanked, screen alive.
        const state = browserState(snapshot);
        assert.equal(state.amount_msats, amountMsats, where);
        assert.equal(state.amountLabel, undefined, where);
        assert.equal(reactModel(snapshot).amountLabel, undefined, where);
        // A checkout_lock attempt is never a display invoice, so that rail
        // renders the deferred (nothing-minted-yet) screen whatever the snapshot
        // says — it has no settled screen to reach. Unrelated to the amount;
        // read the rendering assertions below off the STATE, not the fixture.
        assert.equal(state.settled, settled && rail !== "checkout_lock", where);

        // 2. The payment-data panel (`<PaymentData source={checkoutModel}>` and
        //    the element's payment-data block) — settled-screen only, and the
        //    site the reviewer found throwing.
        const entries = createOpenReceivePaymentDataEntries(state);
        assert.equal(rowValue(entries, "Amount"), undefined, where);
        assert.equal(rowValue(entries, "Amount (msats)"), String(amountMsats), where);

        // 3. The transaction-details rows (`<TransactionDetails>` / the element
        //    renderer), which take the same state.
        const rows = createOpenReceiveTransactionDetailsFromState(state);
        assert.equal(rowValue(rows, "Amount"), undefined, where);
        assert.equal(rowValue(rows, "Amount (msats)"), String(amountMsats), where);

        // 4. The whole screen, both renderers. These are the assertions that
        //    fail as a THROW rather than as a mismatch when the guard is missing
        //    from a display site.
        const reactHtml = renderToStaticMarkup(
          React.createElement(Checkout, { checkout: snapshot }),
        );
        assert.match(reactHtml, /data-openreceive-checkout/, where);

        // `liveState` is what a mounted element passes after a poll
        // (define-elements.ts), and `amount_msats` is the attribute the caption
        // is derived from in create mode — both amount paths at once.
        const elementHtml = renderCheckoutHtml({
          invoice: state.invoice,
          rail: state.rail,
          payment_hash: state.payment_hash,
          amount_msats: amountMsats,
          status: state.settled ? "settled" : "pending",
          liveState: state,
        });
        assert.match(elementHtml, /<section part="root"/, where);

        for (const html of [reactHtml, elementHtml]) {
          // A blanked label must not leave "undefined" or "NaN" behind where the
          // amount used to be. The element inlines the compiled stylesheet;
          // scan the markup only.
          const markup = html.replace(/<style[\s\S]*?<\/style>/g, "");
          assert.doesNotMatch(markup, /undefined/, where);
          assert.doesNotMatch(markup, /NaN/, where);
          // The settled screen still REPORTS the amount it refused to format.
          if (state.settled) assert.match(markup, /Amount \(msats\)/, where);
        }
      }
    }
  }
});

test("a good amount still formats on every rail and both screens", () => {
  // The blanking rule above must not blank a legitimate amount — including the
  // legitimate zero, which is falsy and the obvious thing for a guard to get
  // wrong.
  for (const amountMsats of [0, 1_000, 200_000]) {
    for (const rail of RAILS) {
      for (const settled of [false, true]) {
        const where = `${rail}/${settled ? "settled" : "pending"}/${amountMsats}`;
        const state = browserState(nonsenseAmountSnapshot({ rail, settled, amountMsats }));
        const expected = amountMsats === 1_000 ? "1 sat" : `${amountMsats / 1000} sats`;
        assert.equal(state.amountLabel, expected, where);
        assert.equal(
          rowValue(createOpenReceivePaymentDataEntries(state), "Amount"),
          `${expected} (${amountMsats} msats)`,
          where,
        );
        const rows = createOpenReceiveTransactionDetailsFromState(state);
        assert.equal(rowValue(rows, "Amount"), expected, where);
        assert.equal(rowValue(rows, "Amount (msats)"), String(amountMsats), where);
      }
    }
  }
});

// ------------------------------------------ a malformed timestamp is one row --

// The SAME rule as the amount block above, one field over. `new Date(ms)` is
// only defined for |ms| <= 8.64e15 (ECMAScript time range), so a unix-seconds
// value past 8.64e12 makes `toISOString()` throw `RangeError: Invalid time
// value`. That is not a hypothetical value: 1e13 is exactly what a server that
// answers `paid_at` in MILLISECONDS instead of seconds sends, and the transport
// admits it — `optionalSafeInteger(payment.paid_at)` and
// `requiredSafeInteger(checkout.expires_at)` bound the TYPE, not the MAGNITUDE
// (a deliberate decision, recorded in checkout-transport.ts).
//
// So the display side has to hold: every timestamp renders through
// `optionalUnixTimeLabel`, and a value no clock can render costs its own row,
// which is re-added raw under a "(unix seconds)" label — the same trade the
// amount rows make with "Amount (msats)". Support has to be able to SEE the
// unit mistake; the payer must not lose the settled screen to it.
const BAD_TIMESTAMPS = [1e13, 1e15, Number.MAX_SAFE_INTEGER];

function timestampSnapshot({ rail, settled, settledAt, expiresAt }) {
  const attempt = {
    invoice_id: `or_inv_time_${rail}`,
    // Only the Lightning rail requires a display bolt11.
    invoice: rail === "lightning" ? "lnbc-bad-time" : null,
    rail,
    payment_hash: hash("f"),
    amount_msats: 200_000,
    transaction_state: settled ? "settled" : "pending",
    workflow_state: settled ? "paid" : "invoice_created",
    expires_at: expiresAt,
    ...(settled ? { settled_at: settledAt } : {}),
    ...(rail === "swap"
      ? {
          swap: {
            provider: "lightning-swap-com",
            pay_in_asset: "SOL_SOL",
            deposit_address: "SoLAddress",
            deposit_amount: "0.027479",
            provider_state: settled ? "completed" : "awaiting_deposit",
            provider_expires_at: expiresAt,
          },
        }
      : {}),
  };
  return {
    checkout_id: `or_chk_time_${rail}`,
    order_id: `order-time-${rail}`,
    status: settled ? "paid" : "open",
    ...(settled ? { paid_at: settledAt } : {}),
    amount_msats: 200_000,
    ...(settled ? {} : { active: attempt }),
    invoices: [attempt],
  };
}

test("a malformed timestamp costs the row, not the payment screen", () => {
  for (const seconds of BAD_TIMESTAMPS) {
    for (const rail of RAILS) {
      for (const settled of [false, true]) {
        const where = `${rail}/${settled ? "settled" : "pending"}/${seconds}`;
        const snapshot = timestampSnapshot({
          rail,
          settled,
          settledAt: seconds,
          expiresAt: seconds,
        });

        // 1. The state itself: raw timestamps kept, screen alive.
        //
        //    A checkout_lock attempt is DEFERRED — nothing minted yet — so
        //    `createCheckoutState` returns the minimal state with no expiry and
        //    no settlement at all, whatever the fixture says. Same caveat as the
        //    amount matrix above: read the row assertions off the STATE.
        const state = browserState(snapshot);
        assert.equal(state.settled, settled && rail !== "checkout_lock", where);
        if (rail === "checkout_lock") {
          assert.equal(state.expires_at, undefined, where);
          assert.equal(state.settled_at, undefined, where);
        } else {
          assert.equal(state.expires_at, seconds, where);
          if (state.settled) assert.equal(state.settled_at, seconds, where);
        }

        // 2. The payment-data panel — the settled-screen projection the
        //    reviewer found throwing out of its `isoDate` helper.
        const entries = createOpenReceivePaymentDataEntries(state);
        if (state.expires_at !== undefined) {
          assert.equal(rowValue(entries, "Invoice expires at"), undefined, where);
          assert.equal(
            rowValue(entries, "Invoice expires at (unix seconds)"),
            String(seconds),
            where,
          );
        }
        if (state.settled) {
          assert.equal(rowValue(entries, "Settled at"), undefined, where);
          assert.equal(rowValue(entries, "Settled at (unix seconds)"), String(seconds), where);
        }

        // 3. The transaction-details rows, which throw one level down in
        //    `formatOpenReceiveUnixTime` instead.
        const rows = createOpenReceiveTransactionDetailsFromState(state);
        if (state.expires_at !== undefined) {
          assert.equal(rowValue(rows, "Expires at"), undefined, where);
          assert.equal(rowValue(rows, "Expires at (unix seconds)"), String(seconds), where);
        }
        if (state.settled) {
          assert.equal(rowValue(rows, "Settled at"), undefined, where);
          assert.equal(rowValue(rows, "Settled at (unix seconds)"), String(seconds), where);
        }
        if (state.swap !== undefined) {
          assert.equal(rowValue(rows, "Provider expires at"), undefined, where);
          assert.equal(
            rowValue(rows, "Provider expires at (unix seconds)"),
            String(seconds),
            where,
          );
        }

        // 4. The whole screen, both renderers — the assertions that fail as a
        //    THROW rather than a mismatch when a display site is unguarded.
        const reactHtml = renderToStaticMarkup(
          React.createElement(Checkout, { checkout: snapshot }),
        );
        assert.match(reactHtml, /data-openreceive-checkout/, where);

        const elementHtml = renderCheckoutHtml({
          invoice: state.invoice,
          rail: state.rail,
          payment_hash: state.payment_hash,
          amount_msats: state.amount_msats,
          status: state.settled ? "settled" : "pending",
          liveState: state,
        });
        assert.match(elementHtml, /<section part="root"/, where);

        for (const html of [reactHtml, elementHtml]) {
          // A dropped row must not leave "Invalid Date", "undefined" or "NaN"
          // behind. The element inlines the compiled stylesheet; scan markup only.
          const markup = html.replace(/<style[\s\S]*?<\/style>/g, "");
          assert.doesNotMatch(markup, /undefined/, where);
          assert.doesNotMatch(markup, /NaN/, where);
          assert.doesNotMatch(markup, /Invalid Date/, where);
        }
      }
    }
  }
});

test("a legitimate timestamp still formats on every rail and both panels", () => {
  // The guard above must not start blanking valid dates — the whole point of
  // bounding the magnitude is that everything INSIDE the bound still renders.
  // The far edge of the ECMAScript time range is included on purpose: it is the
  // largest value the boundary must still accept, and an off-by-one in the
  // comparison would blank it.
  const MAX_DISPLAYABLE = 8.64e12;
  for (const rail of RAILS) {
    for (const settled of [false, true]) {
      const where = `${rail}/${settled ? "settled" : "pending"}`;
      const state = browserState(
        timestampSnapshot({ rail, settled, settledAt: NOW - 10, expiresAt: NOW + 600 }),
      );

      const entries = createOpenReceivePaymentDataEntries(state);
      const rows = createOpenReceiveTransactionDetailsFromState(state);
      // Deferred checkout_lock has no timestamps to render at all (see above);
      // pinning that here keeps the guard from being credited for a row the
      // state never carried.
      if (state.expires_at === undefined) {
        assert.equal(rail, "checkout_lock", where);
        assert.equal(rowValue(entries, "Invoice expires at"), undefined, where);
        assert.equal(rowValue(rows, "Expires at"), undefined, where);
        continue;
      }
      assert.equal(rowValue(entries, "Invoice expires at"), iso(NOW + 600), where);
      assert.equal(rowValue(entries, "Invoice expires at (unix seconds)"), undefined, where);
      assert.equal(rowValue(rows, "Expires at"), iso(NOW + 600), where);
      assert.equal(rowValue(rows, "Expires at (unix seconds)"), undefined, where);
      if (state.settled) {
        assert.equal(rowValue(entries, "Settled at"), iso(NOW - 10), where);
        assert.equal(rowValue(entries, "Settled at (unix seconds)"), undefined, where);
        assert.equal(rowValue(rows, "Settled at"), iso(NOW - 10), where);
      }
      if (state.swap !== undefined) {
        assert.equal(rowValue(rows, "Provider expires at"), iso(NOW + 600), where);
        assert.equal(rowValue(rows, "Provider expires at (unix seconds)"), undefined, where);
      }
    }
  }

  // The bound itself, at both ends, straight through the barrel formatter.
  assert.equal(formatOpenReceiveUnixTime(MAX_DISPLAYABLE), "+275760-09-13T00:00:00Z");
  assert.equal(formatOpenReceiveUnixTime(1), "1970-01-01T00:00:01Z");
  // One second past the range is not a date any more, so the formatter answers
  // with the raw value instead of throwing — see the note on its guard.
  assert.equal(formatOpenReceiveUnixTime(MAX_DISPLAYABLE + 1), String(MAX_DISPLAYABLE + 1));
  assert.equal(formatOpenReceiveUnixTime(0), "0");
});
