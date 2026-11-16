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

test("a one-network group has no question, so it resolves to review_swap", () => {
  const entries = entriesOf([USDT_TRON, USDT_ETH, SOL]);
  const resolved = resolveWizardSelection({
    pickerKey: swapPickerKey("SOL"),
    previousKey: swapPickerKey("USDT"),
    entries,
    selectedAssetByGroup: { USDT: "USDT_TRON" },
  });
  assert.equal(
    resolved.kind,
    "review_swap",
    "a single-network group must open its amount, never a one-answer network step",
  );
  // The asset to quote, in hand: the renderer derives nothing.
  assert.equal(resolved.payInAsset, "SOL_SOL");
  assert.equal(resolved.groupKey, "SOL");
  assert.equal(resolved.group.options.length, 1);
  assert.equal(resolved.panelId, "network-panel-sol");
  // The map to store back. A one-network coin adds nothing to it, and the
  // network picked for USDT is still there when the payer goes back to it.
  assert.deepEqual(resolved.selectedAssetByGroup, { USDT: "USDT_TRON" });
});

// Price first: looking at a coin opens no order with the swap provider. A tile
// click that started the swap opened one per coin a payer looked at, and a
// provider account holds only so many unpaid orders at once. So nothing a tile
// click can mean starts anything.
test("no tile click resolves to a swap start", () => {
  const entries = entriesOf([USDT_TRON, USDT_ETH, SOL]);
  const kinds = ["method:bitcoin", swapPickerKey("USDT"), swapPickerKey("SOL"), "swap:NOPE"].map(
    (pickerKey) => resolveWizardSelection({ pickerKey, entries }).kind,
  );
  assert.deepEqual(kinds, ["select_method", "choose_network", "review_swap", "none"]);
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
  assert.equal(resolved.payInAsset, undefined, "no network is chosen yet, so nothing to quote");
});

test("a network already set for the coin is the asset on review, straight from the tile", () => {
  const usdcTron = option({ pay_in_asset: "USDC_TRON", label: "USDC", network_label: "Tron" });
  const usdcEth = option({ pay_in_asset: "USDC_ETH", label: "USDC", network_label: "Ethereum" });
  const entries = entriesOf([USDT_TRON, USDT_ETH, usdcTron, usdcEth]);
  // The coin's own earlier pick.
  const own = resolveWizardSelection({
    pickerKey: swapPickerKey("USDT"),
    entries,
    selectedAssetByGroup: { USDT: "USDT_ETH" },
  });
  assert.equal(own.kind, "choose_network");
  assert.equal(own.payInAsset, "USDT_ETH");
  // The previous coin's network, carried over to a coin that has it too.
  const carried = resolveWizardSelection({
    pickerKey: swapPickerKey("USDC"),
    previousKey: swapPickerKey("USDT"),
    entries,
    selectedAssetByGroup: { USDT: "USDT_ETH" },
  });
  assert.equal(carried.kind, "choose_network");
  assert.equal(carried.payInAsset, "USDC_ETH");
  assert.deepEqual(carried.selectedAssetByGroup, { USDT: "USDT_ETH", USDC: "USDC_ETH" });
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

test("a grid of one tile offers no choice, so the payer is not asked to make one", () => {
  const withSwaps = createMethodGridDisplay({ entries: entriesOf([USDT_TRON]) });
  assert.equal(withSwaps.offersChoice, true);
  const lightningOnly = createMethodGridDisplay({ entries: entriesOf([]) });
  assert.deepEqual(
    lightningOnly.entries.map((entry) => entry.kind),
    ["method"],
  );
  assert.equal(lightningOnly.offersChoice, false);
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
  assert.equal(usdt.selected, true);
  assert.equal(usdt.selectedOption.pay_in_asset, "USDT_ETH");
  assert.equal(usdt.activeOption.pay_in_asset, "USDT_ETH");
  assert.equal(usdt.disabled, false);
  assert.equal(usdt.limitMessage, undefined, "an available tile quotes no limit");

  const sol = display.entries.find(
    (entry) => entry.kind === "swap" && entry.group.label === "SOL",
  ).group;
  assert.equal(sol.needsNetworkStep, false);
  assert.equal(sol.selected, false);
  assert.equal(sol.selectedOption, undefined, "a closed one-network tile has nothing on review");
  assert.equal("startPayInAsset" in sol, false, "no tile carries an asset to start");

  assert.equal(display.networkRequired, true);
  assert.equal(display.selectedGroup.groupKey, "USDT");
  assert.deepEqual(display.continueTarget, {
    payInAsset: "USDT_ETH",
    disabled: false,
    starting: false,
    label: checkoutLabels.continue,
    quoting: false,
  });
  assert.equal(display.canContinue, true);
  assert.equal(display.gridBusy, false);
});

// ------------------------------------------------- the review step, as data

const estimateOf = (amount, asset, network) =>
  (network === undefined ? checkoutLabels.swapEstimate : checkoutLabels.swapEstimateOnNetwork)
    .replace("{amount}", amount)
    .replace("{asset}", asset)
    .replace("{network}", network);

test("an open one-network tile is on review: Continue is there with no network step", () => {
  const display = createMethodGridDisplay({
    entries: entriesOf([USDT_TRON, USDT_ETH, SOL]),
    selectedPickerKey: swapPickerKey("SOL"),
    selectedAssetByGroup: {},
  });
  const sol = display.selectedGroup;
  assert.equal(sol.label, "SOL");
  assert.equal(sol.selected, true);
  assert.equal(sol.needsNetworkStep, false);
  assert.equal(sol.selectedOption.pay_in_asset, "SOL_SOL");
  assert.equal(display.networkRequired, false, "one network is not a question");
  // Before any quote has answered: Continue works, and there is no amount.
  assert.deepEqual(display.continueTarget, {
    payInAsset: "SOL_SOL",
    disabled: false,
    starting: false,
    label: checkoutLabels.continue,
    quoting: false,
  });
  assert.equal(display.canContinue, true);
});

test("the amount line is the quote for the asset on review, marked as an estimate", () => {
  const entries = entriesOf([USDT_TRON, USDT_ETH, SOL]);
  const swapQuotes = {
    // What the quote route sends: availability, limits and the amount, keyed
    // by asset. Trailing zeros are the provider's, not the payer's.
    SOL_SOL: { pay_in_asset: "SOL_SOL", available: true, pay_amount: "0.04210000" },
    USDT_TRON: { pay_in_asset: "USDT_TRON", available: true, pay_amount: "12.50" },
    USDT_ETH: { pay_in_asset: "USDT_ETH", available: true, pay_amount: "12.75" },
  };
  const sol = createMethodGridDisplay({
    entries,
    selectedPickerKey: swapPickerKey("SOL"),
    swapQuotes,
  });
  assert.equal(sol.continueTarget.amountText, estimateOf("0.0421", "SOL"));
  assert.match(sol.continueTarget.amountText, /^≈ /, "an estimate until the order exists");
  assert.equal(sol.continueTarget.disabled, false);
  // A quote has eight decimals. The line is read at a glance, so it carries
  // four significant digits; the exact figure is the deposit panel's.
  assert.equal(
    createMethodGridDisplay({
      entries,
      selectedPickerKey: swapPickerKey("USDT"),
      selectedAssetByGroup: { USDT: "USDT_ETH" },
      swapQuotes: { USDT_ETH: { available: true, pay_amount: "12.34567891" } },
    }).continueTarget.amountText,
    estimateOf("12.35", "USDT", "Ethereum"),
  );
  // A coin pegged to a currency is money to the payer, so its estimate is to
  // the cent ("≈ 7.477 USDT" on a $7.00 order looked like a typo). A floating
  // coin given the same digits keeps four significant ones.
  assert.equal(
    createMethodGridDisplay({
      entries,
      selectedPickerKey: swapPickerKey("USDT"),
      selectedAssetByGroup: { USDT: "USDT_ETH" },
      swapQuotes: { USDT_ETH: { available: true, pay_amount: "7.47712345" } },
    }).continueTarget.amountText,
    estimateOf("7.48", "USDT", "Ethereum"),
  );
  assert.equal(
    createMethodGridDisplay({
      entries,
      selectedPickerKey: swapPickerKey("SOL"),
      swapQuotes: { SOL_SOL: { available: true, pay_amount: "7.47712345" } },
    }).continueTarget.amountText,
    estimateOf("7.477", "SOL"),
  );

  // A coin on several networks names the one the amount is for, and each
  // network shows its own amount.
  const onNetwork = (payInAsset) =>
    createMethodGridDisplay({
      entries,
      selectedPickerKey: swapPickerKey("USDT"),
      selectedAssetByGroup: { USDT: payInAsset },
      swapQuotes,
    }).continueTarget.amountText;
  assert.equal(onNetwork("USDT_TRON"), estimateOf("12.50", "USDT", "Tron"));
  assert.equal(onNetwork("USDT_ETH"), estimateOf("12.75", "USDT", "Ethereum"));

  // Until a network is chosen there is nothing to continue with, and no amount.
  const unchosen = createMethodGridDisplay({
    entries,
    selectedPickerKey: swapPickerKey("USDT"),
    swapQuotes,
  });
  assert.equal(unchosen.continueTarget, undefined);
  assert.equal(unchosen.canContinue, false);
});

test("a quote in flight is a flag on the asset it is for, and on no other", () => {
  const entries = entriesOf([USDT_TRON, USDT_ETH, SOL]);
  const quotingSol = createMethodGridDisplay({
    entries,
    selectedPickerKey: swapPickerKey("SOL"),
    quotingAsset: "SOL_SOL",
  });
  assert.equal(quotingSol.continueTarget.quoting, true);
  assert.equal(quotingSol.continueTarget.amountText, undefined);
  assert.equal(quotingSol.continueTarget.disabled, false, "Continue never waits for the quote");

  const quotingOther = createMethodGridDisplay({
    entries,
    selectedPickerKey: swapPickerKey("SOL"),
    quotingAsset: "USDT_TRON",
  });
  assert.equal(quotingOther.continueTarget.quoting, false);
  assert.equal(
    createMethodGridDisplay({
      entries,
      selectedPickerKey: swapPickerKey("SOL"),
      quotingAsset: "",
    }).continueTarget.quoting,
    false,
  );
});

test("an unavailable quote disables Continue with the catalog's own limit message", () => {
  const checkout = { amount_msats: 200_000, fiat: { currency: "USD", value: "0.05" } };
  const tooSmall = {
    available: false,
    unavailable_reason: "amount_too_small",
    minimum_invoice_amount_msats: 271_000,
  };
  // The same figures, once from the catalog and once from the quote: the
  // payer must read one message whichever of the two noticed.
  const fromCatalog = createMethodGridDisplay({
    entries: entriesOf([{ ...USDT_TRON, ...tooSmall }, USDT_ETH]),
    selectedPickerKey: swapPickerKey("USDT"),
    selectedAssetByGroup: { USDT: "USDT_TRON" },
    checkout,
  }).continueTarget;
  const fromQuote = createMethodGridDisplay({
    entries: entriesOf([SOL]),
    selectedPickerKey: swapPickerKey("SOL"),
    swapQuotes: { SOL_SOL: { pay_in_asset: "SOL_SOL", ...tooSmall } },
    checkout,
  });
  assert.equal(fromQuote.continueTarget.disabled, true);
  assert.equal(fromQuote.canContinue, false);
  assert.match(fromQuote.continueTarget.label, /^Minimum amount /);
  assert.equal(fromQuote.continueTarget.label, fromCatalog.label);
  assert.equal(fromQuote.continueTarget.amountText, undefined, "no amount for a coin out of range");
  // The tile itself stays open: the catalog still offers the coin.
  assert.equal(fromQuote.selectedGroup.disabled, false);

  // A refusal that carries no reason still says something on the button.
  const bare = createMethodGridDisplay({
    entries: entriesOf([SOL]),
    selectedPickerKey: swapPickerKey("SOL"),
    swapQuotes: { SOL_SOL: { available: false } },
  }).continueTarget;
  assert.equal(bare.disabled, true);
  assert.equal(bare.label, checkoutLabels.swapUnavailableFallback.replace("{asset}", "SOL"));
});

test("a quote never renames the coin: only availability, limits and the amount are taken", () => {
  const display = createMethodGridDisplay({
    entries: entriesOf([SOL]),
    selectedPickerKey: swapPickerKey("SOL"),
    swapQuotes: {
      SOL_SOL: { label: "USDT", network_label: "Tron", available: true, pay_amount: "0.5" },
    },
  });
  assert.equal(display.continueTarget.amountText, estimateOf("0.5", "SOL"));
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
