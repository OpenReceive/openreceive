// The method grid as data: one resolver for what a tile click MEANS, one
// display model for what a tile LOOKS like. Both renderers used to re-derive
// these ~15 lines apiece, and the agent directions were a third copy in English.
import assert from "node:assert/strict";
import test from "node:test";

process.env.LOG_LEVEL ??= "error";

import {
  buildMethodGridEntries,
  checkoutLabels,
  createMethodGridDisplay,
  paymentMethods,
  resolveWizardSelection,
  swapPickerKey,
} from "@openreceive/browser/headless";

const option = (overrides) => ({
  provider: "fixedfloat",
  available: true,
  ...overrides,
});

// USDT on three networks, SOL on one — the two shapes the rule is about.
const USDT_TRON = option({
  pay_in_asset: "USDT_TRON",
  label: "USDT",
  network_label: "Tron",
});
const USDT_ETH = option({ pay_in_asset: "USDT_ETH", label: "USDT", network_label: "Ethereum" });
const SOL = option({ pay_in_asset: "SOL_SOL", label: "SOL", network_label: "Solana" });
const entriesOf = (options) => buildMethodGridEntries(paymentMethods, options);

test("a one-network group has no question, so it resolves to start_swap", () => {
  const entries = entriesOf([USDT_TRON, USDT_ETH, SOL]);
  assert.deepEqual(
    resolveWizardSelection({ pickerKey: swapPickerKey("SOL"), entries }),
    { kind: "start_swap", payInAsset: "SOL_SOL" },
    "a single-network group must start the swap, never open a one-answer step",
  );
});

test("a multi-network group resolves to the network step, with everything it needs", () => {
  const entries = entriesOf([USDT_TRON, USDT_ETH, SOL]);
  const resolved = resolveWizardSelection({
    pickerKey: swapPickerKey("USDT"),
    previousKey: null,
    entries,
    selectedAssetByGroup: {},
  });
  assert.equal(resolved.kind, "choose_network");
  assert.equal(resolved.groupKey, "USDT");
  assert.equal(resolved.group.options.length, 2);
  assert.equal(resolved.heading, checkoutLabels.chooseAssetNetwork.replace("{asset}", "USDT"));
  // One id pair, so aria-controls and aria-labelledby cannot disagree.
  assert.equal(resolved.panelId, "network-panel-usdt");
  assert.equal(resolved.headingId, "network-heading-usdt");
  assert.deepEqual(resolved.selectedAssetByGroup, {});
});

test("an unresolvable or all-unavailable key resolves to none", () => {
  const entries = entriesOf([SOL]);
  assert.deepEqual(resolveWizardSelection({ pickerKey: "swap:NOPE", entries }), { kind: "none" });
  const outOfRange = entriesOf([{ ...SOL, available: false }]);
  assert.deepEqual(
    resolveWizardSelection({ pickerKey: swapPickerKey("SOL"), entries: outOfRange }),
    { kind: "none" },
    "a lone out-of-range network must not start a swap the server will refuse",
  );
});

test("a method key resolves to select_method", () => {
  assert.deepEqual(
    resolveWizardSelection({ pickerKey: "method:bitcoin", entries: entriesOf([SOL]) }),
    { kind: "select_method", methodId: "bitcoin" },
  );
});

test("the grid display model carries the rule as data", () => {
  const display = createMethodGridDisplay({
    entries: entriesOf([USDT_TRON, USDT_ETH, SOL]),
    selectedPickerKey: swapPickerKey("USDT"),
    selectedAssetByGroup: { USDT: "USDT_ETH" },
    startingAsset: null,
    checkout: { amount_msats: 200_000, fiat: { currency: "USD", value: "0.05" } },
  });

  const usdt = display.entries.find(
    (entry) => entry.kind === "swap" && entry.group.label === "USDT",
  ).group;
  assert.equal(usdt.multiNetwork, true);
  assert.equal(usdt.needsNetworkStep, true);
  assert.equal(usdt.startPayInAsset, undefined, "a multi-network tile has nothing to start");
  assert.equal(usdt.selected, true);
  assert.equal(usdt.selectedOption.pay_in_asset, "USDT_ETH");
  assert.equal(usdt.activeOption.pay_in_asset, "USDT_ETH");
  assert.equal(usdt.disabled, false);
  assert.equal(usdt.limitMessage, undefined, "an available tile quotes no limit");

  const sol = display.entries.find(
    (entry) => entry.kind === "swap" && entry.group.label === "SOL",
  ).group;
  assert.equal(sol.needsNetworkStep, false);
  assert.equal(sol.startPayInAsset, "SOL_SOL", "a one-network tile starts its swap outright");
  assert.equal(sol.selected, false);

  assert.equal(display.networkRequired, true);
  assert.equal(display.selectedGroup.groupKey, "USDT");
  assert.deepEqual(display.continueTarget, {
    payInAsset: "USDT_ETH",
    disabled: false,
    starting: false,
    label: checkoutLabels.continue,
  });
  assert.equal(display.canContinue, true);
  assert.equal(display.gridBusy, false);
});

test("a disabled group quotes its cheapest entry point, and says why", () => {
  const cheap = option({
    pay_in_asset: "USDT_TRON",
    label: "USDT",
    network_label: "Tron",
    available: false,
    unavailable_reason: "amount_too_small",
    minimum_invoice_amount_msats: 271_000,
  });
  const dear = option({
    pay_in_asset: "USDT_ETH",
    label: "USDT",
    network_label: "Ethereum",
    available: false,
    unavailable_reason: "amount_too_small",
    minimum_invoice_amount_msats: 9_000_000,
  });
  const display = createMethodGridDisplay({
    // Dear first, so a model that just took options[0] would quote the wrong floor.
    entries: entriesOf([dear, cheap]),
    checkout: { amount_msats: 200_000, fiat: { currency: "USD", value: "0.05" } },
  });
  const usdt = display.entries.find((entry) => entry.kind === "swap").group;
  assert.equal(usdt.disabled, true);
  assert.match(usdt.limitMessage, /^Minimum amount /);
  assert.notEqual(
    usdt.limitMessage,
    undefined,
    "a greyed tile must say the number that tells the payer whether to add a dollar",
  );
});

test("a start in flight makes the whole grid inert and names the asset", () => {
  const display = createMethodGridDisplay({
    entries: entriesOf([USDT_TRON, USDT_ETH, SOL]),
    selectedPickerKey: swapPickerKey("USDT"),
    selectedAssetByGroup: { USDT: "USDT_TRON" },
    startingAsset: "USDT_TRON",
  });
  assert.equal(display.gridBusy, true);
  const method = display.entries.find((entry) => entry.kind === "method");
  assert.equal(method.disabled, true);
  const usdt = display.entries.find(
    (entry) => entry.kind === "swap" && entry.group.label === "USDT",
  ).group;
  assert.equal(usdt.starting, true);
  assert.equal(display.continueTarget.starting, true);
  assert.equal(display.continueTarget.label, checkoutLabels.preparingPayment);
  assert.equal(display.canContinue, false);
});

test("an empty startingAsset string is not a start", () => {
  const display = createMethodGridDisplay({
    entries: entriesOf([SOL]),
    startingAsset: "",
  });
  assert.equal(display.gridBusy, false);
});

// ---------------------------------------------------- the deposit copy rows

import { createSwapDisplayModel } from "@openreceive/browser/headless";

const swapInvoiceOf = (swap) => ({
  invoice_id: "or_inv_swap",
  rail: "swap",
  payment_hash: "d".repeat(64),
  transaction_state: "pending",
  workflow_state: "invoice_created",
  expires_at: 2_000_000_900,
  swap: {
    provider: "fixedfloat",
    deposit_address: "TDepositAddress",
    deposit_amount: "0.0326640000",
    provider_state: "awaiting_deposit",
    provider_expires_at: 2_000_000_900,
    ...swap,
  },
});

test("every value the payer must reproduce is a labelled copy row", () => {
  const display = createSwapDisplayModel(swapInvoiceOf({ pay_in_asset: "USDT_TRON" }), {
    now: 2_000_000_000,
  });
  assert.deepEqual(display.copyRows, [
    { label: checkoutLabels.swapCopyAddress, value: "TDepositAddress", selectable: true },
    // BARE: it pastes into a wallet's amount field, where "0.032664 USDT" is
    // not a number. The symbol is joined only where a sentence reads it.
    { label: checkoutLabels.swapCopyAmount, value: "0.032664", selectable: true },
  ]);
  assert.equal(display.depositAmount, "0.032664");
});

test("a memo rail carries the memo as a row, never as prose in a banner", () => {
  const display = createSwapDisplayModel(
    swapInvoiceOf({ pay_in_asset: "XRP_XRP", deposit_memo: "1234567" }),
    { now: 2_000_000_000 },
  );
  assert.deepEqual(
    display.copyRows.map((row) => row.label),
    [checkoutLabels.swapCopyAddress, checkoutLabels.swapCopyMemo, checkoutLabels.swapCopyAmount],
  );
  assert.equal(display.copyRows[1].value, "1234567");
});
