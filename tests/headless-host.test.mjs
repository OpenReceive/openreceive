// The wizard half of `@openreceive/browser/headless`, driven the way an OUTSIDE
// host drives it: prepare -> method grid -> tile click -> network pick ->
// quoteSwap (the amount) -> Continue -> startSwap -> deposit panel, with its
// own store and its own fetch.
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
  selectCurrentSwapInvoice,
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

const PAY_AMOUNTS = { USDT_TRON: "5.1100", USDT_ETH: "5.4000", SOL_SOL: "0.04210000" };

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
      // What the route sends: no name and no network, only what a quote is
      // about. The padded zeros are a provider's, as they arrive.
      return json({
        quote: {
          provider: "fixedfloat",
          pay_asset: body.pay_in_asset,
          available: true,
          pay_amount: PAY_AMOUNTS[body.pay_in_asset],
        },
      });
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

// `session` is optional so the grid can be read before a session exists; with
// one, its quotes are what put the amount beside Continue.
const gridOf = (store, session) =>
  createMethodGridDisplay({
    entries: buildMethodGridEntries(paymentMethods, store.snapshot?.payment_methods ?? []),
    selectedPickerKey: store.selectedPickerKey,
    selectedAssetByGroup: store.selectedAssetByGroup,
    ...(session === undefined
      ? {}
      : { swapQuotes: session.swapQuotes, quotingAsset: session.quotingSwapAsset }),
  });

const swapGroup = (grid, label) =>
  grid.entries.find((entry) => entry.kind === "swap" && entry.group.label === label)?.group;

test("a headless host drives prepare -> grid -> network -> amount -> startSwap -> deposit panel", async () => {
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
  assert.equal(picked.payInAsset, undefined, "no network yet, so no asset to price");
  store.selectedPickerKey = swapPickerKey("USDT");
  store.selectedAssetByGroup = picked.selectedAssetByGroup;

  // 4. The payer picks Tron. The VALUE is the option's `pay_in_asset`, keyed by
  //    the group key — the one convention this whole test exists to pin.
  store.selectedAssetByGroup = { ...store.selectedAssetByGroup, USDT: "USDT_TRON" };
  const chosen = gridOf(store, session);
  assert.equal(swapGroup(chosen, "USDT").selected, true);
  assert.equal(swapGroup(chosen, "USDT").selectedOption.pay_in_asset, "USDT_TRON");
  assert.equal(chosen.canContinue, true);
  assert.equal(chosen.continueTarget.payInAsset, "USDT_TRON");
  assert.equal(chosen.continueTarget.label, checkoutLabels.continue);
  assert.equal(chosen.continueTarget.disabled, false);
  assert.equal(chosen.continueTarget.amountText, undefined, "nothing has been asked yet");

  // 5. PRICE FIRST: the chosen network is the asset on review, so the host
  //    asks what it costs. That is a quote and nothing else — no /swaps.
  const quoting = session.quoteSwap("USDT_TRON");
  assert.equal(session.quotingSwapAsset, "USDT_TRON");
  assert.equal(gridOf(store, session).continueTarget.quoting, true);
  await quoting;
  assert.equal(session.quotingSwapAsset, null);
  assert.deepEqual(server.pathsOf(), [`${PREFIX}/checkouts/prepare`, `${PREFIX}/swaps/quote`]);
  const priced = gridOf(store, session);
  assert.equal(priced.continueTarget.amountText, "≈ 5.11 USDT · Tron");
  assert.equal(priced.continueTarget.quoting, false);
  assert.equal(priced.continueTarget.disabled, false);
  assert.equal(store.startedSwapInvoice, undefined, "a quote starts nothing");
  assert.equal(store.selectedSwapAsset, null);

  // 6. Continue: the session starts the swap, quoting again first.
  await session.startSwap(priced.continueTarget.payInAsset);
  assert.deepEqual(server.pathsOf(), [
    `${PREFIX}/checkouts/prepare`,
    `${PREFIX}/swaps/quote`,
    `${PREFIX}/swaps/quote`,
    `${PREFIX}/swaps`,
  ]);
  assert.deepEqual(store.errors, []);
  assert.equal(store.published.length, 1);
  assert.equal(store.selectedSwapAsset, "USDT_TRON");
  assert.equal(store.startedSwapInvoice.swap.pay_in_asset, "USDT_TRON");

  // 7. The deposit panel, as data.
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

// The one-network half of the same walk. There is no network to ask about, so
// the tile goes straight to the amount — and, like every tile, starts nothing.
test("a one-network coin's tile is a review of its amount, never a swap start", async () => {
  const server = createStubServer();
  const store = createHostStore();
  const session = createHostSession(store, server.fetchStub);
  store.snapshot = await prepareCheckout({
    prefix: PREFIX,
    reference: REFERENCE,
    fetch: server.fetchStub,
  });

  const picked = resolveWizardSelection({
    pickerKey: swapPickerKey("SOL"),
    previousKey: store.selectedPickerKey,
    entries: buildMethodGridEntries(paymentMethods, store.snapshot.payment_methods),
    selectedAssetByGroup: store.selectedAssetByGroup,
  });
  assert.equal(picked.kind, "review_swap");
  assert.equal(picked.payInAsset, "SOL_SOL");
  store.selectedPickerKey = swapPickerKey("SOL");
  store.selectedAssetByGroup = picked.selectedAssetByGroup;
  // Continue is there at once; the amount follows the quote.
  assert.equal(gridOf(store, session).canContinue, true);
  assert.equal(gridOf(store, session).networkRequired, false);

  // A double click, or a re-render that asks again, is one request.
  const first = session.quoteSwap(picked.payInAsset);
  const second = session.quoteSwap(picked.payInAsset);
  await Promise.all([first, second]);
  assert.deepEqual(server.pathsOf(), [`${PREFIX}/checkouts/prepare`, `${PREFIX}/swaps/quote`]);
  assert.equal(session.swapQuotes.SOL_SOL.pay_amount, PAY_AMOUNTS.SOL_SOL);

  const priced = gridOf(store, session);
  assert.equal(priced.continueTarget.payInAsset, "SOL_SOL");
  assert.equal(priced.continueTarget.amountText, "≈ 0.0421 SOL");
  assert.deepEqual(store.errors, []);
  assert.deepEqual(store.published, [], "looking at a coin opens no provider order");
  assert.equal(store.startedSwapInvoice, undefined);
});

// A quote that fails costs the payer nothing, so it tells them nothing: the
// amount line stays empty, Continue still works because `startSwap` quotes
// again itself, and only the log hears about it.
test("a failed quoteSwap is logged, never raised, and leaves nothing behind", async () => {
  const store = createHostStore();
  store.snapshot = { reference: REFERENCE, payment_methods: PAY_OPTIONS };
  const logs = [];
  const session = createCheckoutSession({
    snapshot: () => store.snapshot,
    reference: () => REFERENCE,
    swap: {
      selection: {
        started: () => undefined,
        setStarted: () => {},
        dismissedInvoiceId: () => null,
        setDismissedInvoiceId: () => {},
        setSelectedAsset: (payInAsset) => {
          store.selectedSwapAsset = payInAsset;
        },
      },
      prefix: () => PREFIX,
      fetch: () => async () =>
        new Response(JSON.stringify({ code: "INTERNAL", message: "Exchange rates unavailable." }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    },
    logger: (entry) => logs.push(entry),
    onError: (error) => store.errors.push(error),
    onChange: () => {
      store.changes += 1;
    },
  });

  await session.quoteSwap("SOL_SOL");
  assert.deepEqual(store.errors, [], "onError is for things the payer must be told");
  assert.deepEqual(session.swapQuotes, {});
  assert.equal(session.quotingSwapAsset, null);
  assert.equal(session.swapStartError, undefined);
  assert.equal(store.selectedSwapAsset, null);
  assert.deepEqual(
    logs.filter((entry) => entry.event === "swap.quote.failed"),
    [
      {
        level: "warn",
        event: "swap.quote.failed",
        message:
          "Could not quote the pay-in asset. The picker shows no amount; Continue still works.",
        reference: REFERENCE,
        pay_in_asset: "SOL_SOL",
        status: 503,
        error_code: "INTERNAL",
        error_message: "Exchange rates unavailable.",
      },
    ],
  );
  // The grid the host draws from that: Continue enabled, and no amount.
  store.selectedPickerKey = swapPickerKey("SOL");
  const grid = gridOf(store, session);
  assert.equal(grid.canContinue, true);
  assert.equal(grid.continueTarget.amountText, undefined);
});

// A host that cannot quote cannot start either, and `startSwap` is where that
// is said (the two tests below). `quoteSwap` only means "no amount".
test("quoteSwap without swap wiring does nothing, quietly", async () => {
  const store = createHostStore();
  const session = createCheckoutSession({
    snapshot: () => store.snapshot,
    reference: () => REFERENCE,
    onError: (error) => store.errors.push(error),
    onChange: () => {
      store.changes += 1;
    },
  });
  await session.quoteSwap("USDT_TRON");
  assert.deepEqual(store.errors, []);
  assert.equal(store.changes, 0);
  assert.equal(session.quotingSwapAsset, null);
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

// The "Switch payment method" regression. The selector used to fall back to
// "the first swap attempt that is not the dismissed one", so once an order had
// two attempts, leaving the second reopened the FIRST coin's deposit, and every
// further click re-dismissed the same attempt, so the exit did nothing.
test("a dismissal hides every swap attempt, not just the one the payer left", () => {
  const attempt = (invoiceId, payInAsset) => ({
    invoice_id: invoiceId,
    rail: "swap",
    payment_hash: invoiceId.padEnd(64, "0"),
    swap: {
      provider: "fixedfloat",
      pay_in_asset: payInAsset,
      deposit_address: "So11111111111111111111111111111111111111112",
      deposit_amount: "1.05",
      provider_state: "awaiting_deposit",
      provider_expires_at: EXPIRES_AT,
    },
  });
  const usdt = attempt("a1", "USDT_SOL");
  const sol = attempt("b2", "SOL_SOL");
  const snapshot = { reference: REFERENCE, invoices: [usdt, sol] };

  // Showing the attempt this session started, as the snapshot carries it.
  assert.equal(selectCurrentSwapInvoice(snapshot, { started: sol })?.invoice_id, "b2");
  // Leaving it shows NO deposit, not the USDT one left before it.
  assert.equal(
    selectCurrentSwapInvoice(snapshot, { started: sol, dismissedInvoiceId: "b2" }),
    undefined,
  );
  // Same with nothing started this session (a resumed attempt the payer left).
  assert.equal(
    selectCurrentSwapInvoice(snapshot, { started: null, dismissedInvoiceId: "a1" }),
    undefined,
  );
  // With nothing dismissed, the resumed attempt is still found in the snapshot.
  assert.equal(selectCurrentSwapInvoice(snapshot)?.invoice_id, "a1");
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
