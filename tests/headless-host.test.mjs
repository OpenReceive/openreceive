// The wizard half of `@openreceive/browser/headless`, driven the way an OUTSIDE
// host drives it: prepare -> method grid -> tile click -> network pick ->
// startSwap -> deposit panel, with its own store and its own fetch.
//
// This file exists because that path had no test. The two in-repo renderers
// (@openreceive/react, @openreceive/elements) were written alongside the
// surface and share its assumptions, and the "flagship headless example" uses
// React's `PaymentWizard` for the whole wizard — so the first outside consumer
// was the first test, and it hit an undocumented required option and an
// inverted value convention inside an hour.
//
// THE RULE FOR THIS FILE: nothing from @openreceive/react or
// @openreceive/elements, ever. Import it and this stops being the test it is.
import assert from "node:assert/strict";
import test from "node:test";

process.env.LOG_LEVEL ??= "error";

import {
  buildMethodGridEntries,
  createCheckoutSession,
  createMethodGridDisplay,
  createSwapDisplayModel,
  createWizardRouteDisplays,
  checkoutLabels,
  getPaymentWizardRoutes,
  paymentMethods,
  prepareCheckout,
  resolveWizardSelection,
  swapPickerKey,
} from "@openreceive/browser/headless";

const PREFIX = "/openreceive";
const REFERENCE = "order-headless";
const EXPIRES_AT = 1_800_000_600;
const NOW = 1_800_000_000;

const PAY_OPTIONS = [
  {
    pay_in_asset: "USDT_TRON",
    label: "USDT",
    network_label: "Tron",
    provider: "fixedfloat",
    available: true,
  },
  {
    pay_in_asset: "USDT_ETH",
    label: "USDT",
    network_label: "Ethereum",
    provider: "fixedfloat",
    available: true,
  },
  {
    pay_in_asset: "SOL_SOL",
    label: "SOL",
    network_label: "Solana",
    provider: "fixedfloat",
    available: true,
  },
];

/** A server, as a fetch. Nothing here knows about a renderer. */
function createStubServer() {
  const calls = [];
  const fetchStub = async (input, init) => {
    const url = new URL(String(input), "http://host.local");
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
    calls.push({ path: url.pathname, body });
    if (url.pathname === `${PREFIX}/checkouts/prepare`) {
      return json({
        reference: body.reference,
        amount_msats: 2_000_000,
        fiat_quote: { fiat: { currency: "USD", value: "5.00" } },
        payment_methods: PAY_OPTIONS,
      });
    }
    if (url.pathname === `${PREFIX}/swaps/quote`) {
      return json({ quote: { pay_asset: body.pay_in_asset, label: "USDT", available: true } });
    }
    if (url.pathname === `${PREFIX}/swaps`) {
      return json({
        swap: {
          payment_hash: "a".repeat(64),
          provider: "fixedfloat",
          pay_in_asset: body.pay_in_asset,
          deposit_address: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
          deposit_amount: "5.11",
          provider_state: "awaiting_deposit",
          provider_expires_at: EXPIRES_AT,
        },
      });
    }
    throw new Error(`unexpected route ${url.pathname}`);
  };
  return { fetchStub, calls, pathsOf: () => calls.map((call) => call.path) };
}

function json(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The host's own state, in plain fields — no framework, no store library. This
 * is exactly the five accessors `swap.selection` asks for, over values the host
 * was already holding.
 */
function createHostStore() {
  return {
    snapshot: undefined,
    selectedPickerKey: null,
    selectedAssetByGroup: {},
    startedSwapInvoice: undefined,
    dismissedInvoiceId: null,
    selectedSwapAsset: null,
    published: [],
    errors: [],
    changes: 0,
  };
}

function createHostSession(store, fetchStub) {
  return createCheckoutSession({
    snapshot: () => store.snapshot,
    reference: () => store.snapshot?.reference,
    swap: {
      selection: {
        started: () => store.startedSwapInvoice,
        setStarted: (invoice) => {
          store.startedSwapInvoice = invoice;
        },
        dismissedInvoiceId: () => store.dismissedInvoiceId,
        setDismissedInvoiceId: (invoiceId) => {
          store.dismissedInvoiceId = invoiceId;
        },
        setSelectedAsset: (payInAsset) => {
          store.selectedSwapAsset = payInAsset;
        },
      },
      prefix: () => PREFIX,
      fetch: () => fetchStub,
      onStarted: (invoice) => store.published.push(invoice),
    },
    onError: (error) => store.errors.push(error),
    onChange: () => {
      store.changes += 1;
    },
  });
}

const gridOf = (store) =>
  createMethodGridDisplay({
    entries: buildMethodGridEntries(paymentMethods, store.snapshot?.payment_methods ?? []),
    selectedPickerKey: store.selectedPickerKey,
    selectedAssetByGroup: store.selectedAssetByGroup,
  });

const swapGroup = (grid, label) =>
  grid.entries.find((entry) => entry.kind === "swap" && entry.group.label === label)?.group;

test("a headless host drives prepare -> grid -> network -> startSwap -> deposit panel", async () => {
  const server = createStubServer();
  const store = createHostStore();
  const session = createHostSession(store, server.fetchStub);

  // 1. Prepare: the amount is locked and the pay-in catalog arrives, with no
  //    Lightning invoice minted.
  store.snapshot = await prepareCheckout({
    prefix: PREFIX,
    reference: REFERENCE,
    fetch: server.fetchStub,
  });
  assert.equal(store.snapshot.reference, REFERENCE);
  assert.equal(store.snapshot.active.rail, "checkout_lock");
  assert.equal(store.snapshot.payment_methods.length, 3);

  // 2. The grid: one Bitcoin tile plus one tile per coin, none selected.
  const initial = gridOf(store);
  assert.deepEqual(
    initial.entries.map((entry) => (entry.kind === "method" ? entry.method.id : entry.group.label)),
    ["bitcoin", "USDT", "SOL"],
  );
  assert.equal(initial.canContinue, false);
  assert.equal(swapGroup(initial, "USDT").selected, false);
  assert.equal(swapGroup(initial, "USDT").needsNetworkStep, true);
  // One network is not a question, so that tile never opens a network step.
  assert.equal(swapGroup(initial, "SOL").needsNetworkStep, false);

  // 3. Tile click on the multi-network coin: a network step, and the map the
  //    host stores back.
  const picked = resolveWizardSelection({
    pickerKey: swapPickerKey("USDT"),
    previousKey: store.selectedPickerKey,
    entries: buildMethodGridEntries(paymentMethods, store.snapshot.payment_methods),
    selectedAssetByGroup: store.selectedAssetByGroup,
  });
  assert.equal(picked.kind, "choose_network");
  store.selectedPickerKey = swapPickerKey("USDT");
  store.selectedAssetByGroup = picked.selectedAssetByGroup;

  // 4. The payer picks Tron. The VALUE is the option's `pay_in_asset`, keyed by
  //    the group key — the one convention this whole test exists to pin.
  store.selectedAssetByGroup = { ...store.selectedAssetByGroup, USDT: "USDT_TRON" };
  const chosen = gridOf(store);
  assert.equal(swapGroup(chosen, "USDT").selected, true);
  assert.equal(swapGroup(chosen, "USDT").selectedOption.pay_in_asset, "USDT_TRON");
  assert.equal(chosen.canContinue, true);
  assert.equal(chosen.continueTarget.payInAsset, "USDT_TRON");
  assert.equal(chosen.continueTarget.label, checkoutLabels.continue);
  assert.equal(chosen.continueTarget.disabled, false);

  // 5. Continue: the session starts the swap, quoting first.
  await session.startSwap(chosen.continueTarget.payInAsset);
  assert.deepEqual(server.pathsOf(), [
    `${PREFIX}/checkouts/prepare`,
    `${PREFIX}/swaps/quote`,
    `${PREFIX}/swaps`,
  ]);
  assert.deepEqual(store.errors, []);
  assert.equal(store.published.length, 1);
  assert.equal(store.selectedSwapAsset, "USDT_TRON");
  assert.equal(store.startedSwapInvoice.swap.pay_in_asset, "USDT_TRON");

  // 6. The deposit panel, as data.
  const display = createSwapDisplayModel(store.startedSwapInvoice, { now: NOW });
  assert.equal(display.payInAsset, "USDT_TRON");
  // A token on a chain the address format does not pin: the loud warning.
  assert.equal(display.depositRisk, "asset_only");
  assert.deepEqual(
    display.copyRows.map((row) => row.label),
    [checkoutLabels.swapCopyAddress, checkoutLabels.swapCopyAmount],
  );
  // The BARE amount, with no ticker glued to it — it pastes into a wallet field.
  assert.equal(
    display.copyRows.find((row) => row.label === checkoutLabels.swapCopyAmount).value,
    "5.11",
  );
  // This host declared no resume path, so the refund screen must not tell the
  // payer to bookmark a page that will not bring them back.
  assert.equal(display.refundReturnLabel, checkoutLabels.refundNoReturnWarning);
});

// D2's regression: the name used to say "networks" and the guides used to say
// "the updated network map", so the obvious wrong write is `network_label`.
// Typed, silent, and the tile simply never selects.
test("selectedAssetByGroup is keyed by group key and valued by pay_in_asset", () => {
  const store = createHostStore();
  store.snapshot = { reference: REFERENCE, payment_methods: PAY_OPTIONS };
  store.selectedPickerKey = swapPickerKey("USDT");

  store.selectedAssetByGroup = { USDT: "Tron" };
  assert.equal(
    swapGroup(gridOf(store), "USDT").selectedOption,
    undefined,
    "a network_label value must not resolve to an option",
  );
  assert.equal(gridOf(store).canContinue, false);

  store.selectedAssetByGroup = { USDT: "USDT_TRON" };
  assert.equal(swapGroup(gridOf(store), "USDT").selectedOption.pay_in_asset, "USDT_TRON");
  assert.equal(gridOf(store).canContinue, true);
});

// D1's regression: `swapSelection` / `swapPrefix` / `fetch` used to be three
// optional fields, so a host could supply two of three and `startSwap` returned
// at the first `undefined` — no throw, no onError, no state change. The payer
// clicked Continue and the screen did not move.
test("a session with no swap options reports the miss instead of doing nothing", async () => {
  const store = createHostStore();
  const session = createCheckoutSession({
    snapshot: () => store.snapshot,
    reference: () => REFERENCE,
    onError: (error) => store.errors.push(error),
    onChange: () => {
      store.changes += 1;
    },
  });
  await session.startSwap("USDT_TRON");
  assert.equal(store.errors.length, 1);
  assert.match(store.errors[0].message, /startSwap needs the session's `swap` options/);
});

test("a swap prefix or fetch that answers undefined is reported, not swallowed", async () => {
  const store = createHostStore();
  const session = createCheckoutSession({
    snapshot: () => store.snapshot,
    reference: () => REFERENCE,
    swap: {
      selection: {
        started: () => undefined,
        setStarted: () => {},
        dismissedInvoiceId: () => null,
        setDismissedInvoiceId: () => {},
        setSelectedAsset: () => {},
      },
      // A standalone wizard whose host has not resolved a prefix yet.
      prefix: () => undefined,
      fetch: () => undefined,
    },
    onError: (error) => store.errors.push(error),
    onChange: () => {
      store.changes += 1;
    },
  });
  await session.startSwap("USDT_TRON");
  assert.equal(store.errors.length, 1);
  assert.match(store.errors[0].message, /swap\.prefix\(\) and swap\.fetch\(\)/);
});

// The other half of the pair D4 is about: `getPaymentWizardRoutes` and
// `createWizardRouteDisplays` read as one API and are now reachable from one
// import, and the registry's ~37 wallets need a limit before they go under an
// invoice.
test("wallet suggestions come off one import, with the count a show-more needs", () => {
  const [route] = createWizardRouteDisplays(getPaymentWizardRoutes(), {
    providerPreviewLimit: 4,
  });
  assert.equal(route.providers.length, 4);
  assert.ok(route.providerCount > 4, "the display carries the untruncated total");
  const [everything] = createWizardRouteDisplays(getPaymentWizardRoutes());
  assert.equal(everything.providers.length, everything.providerCount);
});
