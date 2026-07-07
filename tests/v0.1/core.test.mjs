import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryInvoiceKvStore,
  OpenReceiveError,
  classifyTransactionSettlement,
  createIdempotencyRequestHash,
  getIdempotentRecord,
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveMissingNwcMessage,
  isOpenReceiveErrorCode,
  isRetryableOpenReceiveErrorCode,
  putCreatedInvoiceRecord,
  quoteBitcoinAmountToMsats,
  parseNwcUri,
  quoteFiatToMsats,
  redactNwcUri,
  sweepPendingInvoicesOnce,
} from "../../packages/js/core/src/index.ts";
import { OPENRECEIVE_ERROR_CODES } from "../../packages/js/core/src/contracts.ts";
import {
  OPENRECEIVE_COUNTRY_MAP_HEIGHT,
  OPENRECEIVE_COUNTRY_MAP_VIEW_BOX,
  OPENRECEIVE_COUNTRY_MAP_WIDTH,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_DATA_SELECTORS,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_PARTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_SELECTORS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS,
  copyInvoice,
  createCheckoutActionEvent,
  createCheckoutController,
  createCheckoutDisplayModel,
  createCheckoutErrorEvent,
  createCheckoutSnapshotFromDisplayData,
  createCheckoutStatusModel,
  createCheckoutState,
  createCheckoutStateFromDisplayData,
  createCheckoutStateEvent,
  createOpenReceiveCountryPickerModel,
  createOpenReceiveStatusFetcher,
  createCheckoutProviderCopyEvent,
  createOpenReceiveThemeChangeEvent,
  createOpenReceiveTransientFeedbackController,
  createLightningUri,
  createQrSvg,
  escapeOpenReceiveHtml,
  formatOpenReceiveCountryMetaLabel,
  formatOpenReceivePaymentHashLabel,
  CheckoutWatcher,
  createOpenReceiveThemeModel,
  openReceiveCheckoutElementStyles,
  openReceiveCountryMapRegions,
  openReceiveThemeToggleElementStyles,
  openWallet,
  requestCheckout,
  assertOpenReceiveDisplayInvoice,
  parseOpenReceiveBooleanAttribute,
  parseOpenReceiveOptionalInteger,
  parseOpenReceivePaymentMethod,
  parseOpenReceiveRegion,
  parseOpenReceiveResolvedTheme,
  parseOpenReceiveThemePreference,
  shouldCheckoutShowWaiting,
} from "../../packages/js/browser/src/internal.ts";
import { openReceiveCountryMapLandPaths } from "../../packages/js/browser/src/country-map.ts";

const PAYMENT_HASH = "a".repeat(64);
const NWC_URI =
  "nostr+walletconnect://" +
  "b".repeat(64) +
  "?relay=wss%3A%2F%2Frelay.example.com&secret=" +
  "c".repeat(64) +
  "&lud16=demo%40example.com";
const TRANSACTION_SCAN_CURSOR_KEY = "transaction_scan_cursor:v2:global";

function seedRecord(overrides = {}) {
  const rowOverrides = overrides.row === undefined ? {} : overrides.row;
  const flatOverrides = { ...overrides };
  delete flatOverrides.row;
  delete flatOverrides.rev;
  const invoiceId = rowOverrides.invoice_id ?? flatOverrides.invoice_id ?? "or_inv_test";
  const flatMetadata = flatOverrides.metadata === undefined ? {} : flatOverrides.metadata;
  const rowMetadata = rowOverrides.metadata === undefined ? {} : rowOverrides.metadata;
  const metadataOverrides = {
    ...flatMetadata,
    ...rowMetadata,
  };
  return {
    rev: overrides.rev ?? 0,
    row: {
      invoice_id: invoiceId,
      namespace: "demo:tenant",
      operation: "invoice.create",
      idempotency_key: "order-1",
      idempotency_request_hash: `sha256:${"a".repeat(64)}`,
      payment_hash: PAYMENT_HASH,
      invoice: "lnbc-test",
      amount_msats: 200000,
      transaction_state: "pending",
      workflow_state: "invoice_created",
      settlement_action_state: "pending",
      created_at: 1000,
      expires_at: 1600,
      ...flatOverrides,
      ...rowOverrides,
      metadata: {
        order_id: metadataOverrides.order_id ?? invoiceId,
        checkout_id: metadataOverrides.checkout_id ?? `or_chk_${invoiceId}`,
        ...metadataOverrides,
      },
    },
  };
}

function temporalTransactionPage(transactions, request) {
  const from = request.from ?? 0;
  const until = request.until ?? Number.MAX_SAFE_INTEGER;
  const limit = request.limit ?? Number.MAX_SAFE_INTEGER;
  return transactions
    .filter((transaction) => transaction.created_at >= from && transaction.created_at <= until)
    .sort((left, right) =>
      left.created_at === right.created_at
        ? right.payment_hash.localeCompare(left.payment_hash)
        : right.created_at - left.created_at,
    )
    .slice(0, limit);
}

function checkoutSnapshot(invoiceOverrides = {}, checkoutOverrides = {}) {
  const invoice = {
    invoice_id: invoiceOverrides.invoice_id ?? "or_inv_checkout",
    invoice: invoiceOverrides.invoice ?? "lnbc-checkout",
    rail: invoiceOverrides.rail ?? "lightning",
    payment_hash: invoiceOverrides.payment_hash ?? PAYMENT_HASH,
    amount_msats: invoiceOverrides.amount_msats ?? checkoutOverrides.amount_msats ?? 200000,
    transaction_state: invoiceOverrides.transaction_state ?? "pending",
    workflow_state: invoiceOverrides.workflow_state ?? "invoice_created",
    ...(invoiceOverrides.expires_at === undefined
      ? {}
      : { expires_at: invoiceOverrides.expires_at }),
    ...(invoiceOverrides.settled_at === undefined
      ? {}
      : { settled_at: invoiceOverrides.settled_at }),
    ...(invoiceOverrides.fiat_quote === undefined
      ? {}
      : { fiat_quote: invoiceOverrides.fiat_quote }),
  };
  const status =
    checkoutOverrides.status ?? (invoice.transaction_state === "settled" ? "paid" : "open");
  return {
    checkout_id: checkoutOverrides.checkout_id ?? `or_chk_${invoice.invoice_id}`,
    order_id: checkoutOverrides.order_id ?? `order_${invoice.invoice_id}`,
    status,
    amount_msats: checkoutOverrides.amount_msats ?? invoice.amount_msats,
    ...(checkoutOverrides.fiat === undefined ? {} : { fiat: checkoutOverrides.fiat }),
    ...(status === "paid" ? {} : { active: invoice }),
    invoices: [invoice],
    ...(checkoutOverrides.paid_at === undefined ? {} : { paid_at: checkoutOverrides.paid_at }),
    ...(checkoutOverrides.created_at === undefined
      ? {}
      : { created_at: checkoutOverrides.created_at }),
  };
}

test("quotes static USD fiat to whole-sat msats without floating point drift", () => {
  const quote = quoteFiatToMsats({
    fiat: {
      currency: "USD",
      value: "0.10",
    },
    as_of: 1781740800,
  });

  assert.equal(quote.amount_sats, 200);
  assert.equal(quote.amount_msats, 200000);
  assert.equal(quote.btc_fiat_price, "50000.00");
  assert.equal(quote.expires_at, 1781741400);
});

test("quotes BTC and satoshi amounts without price feeds", () => {
  assert.deepEqual(
    quoteBitcoinAmountToMsats({
      currency: "BTC",
      value: "0.005",
    }),
    {
      amount_sats: 500000,
      amount_msats: 500000000,
    },
  );

  assert.deepEqual(
    quoteBitcoinAmountToMsats({
      currency: "SATS",
      value: "7000",
    }),
    {
      amount_sats: 7000,
      amount_msats: 7000000,
    },
  );

  assert.throws(
    () =>
      quoteBitcoinAmountToMsats({
        currency: "SAT",
        value: "1.5",
      }),
    /SATS amount must be a whole number of satoshis/,
  );
});

test("parses and redacts NWC URI without leaking the client secret", () => {
  const parsed = parseNwcUri(NWC_URI);

  assert.equal(parsed.walletPubkey, "b".repeat(64));
  assert.deepEqual(parsed.relays, ["wss://relay.example.com"]);
  assert.equal(parsed.clientSecret, "c".repeat(64));
  assert.equal(parsed.lud16, "demo@example.com");
  assert.match(parsed.redacted, /secret=\[REDACTED\]/);
  assert.doesNotMatch(parsed.redacted, /c{64}/);
  assert.equal(redactNwcUri(NWC_URI), parsed.redacted);
});

test("NWC boot messages explain the receive-only code requirement", () => {
  const missing = formatOpenReceiveMissingNwcMessage({ subject: "Demo" });
  assert.match(missing, /Demo needs a receive-only NWC code to receive payments\./);
  assert.match(missing, /Set OPENRECEIVE_NWC/);
  assert.match(missing, /https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/);

  const invalid = formatOpenReceiveInvalidNwcMessage({ reason: "bad scheme" });
  assert.match(invalid, /not a valid NWC code/);
  assert.match(invalid, /bad scheme/);
  assert.match(invalid, /https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/);
});

test("canonical OpenReceive errors expose stable schema codes", () => {
  assert.equal(OPENRECEIVE_ERROR_CODES.includes("PAYMENT_FAILED"), true);
  assert.equal(isOpenReceiveErrorCode("INSUFFICIENT_BALANCE"), true);
  assert.equal(isOpenReceiveErrorCode("insufficient_balance"), false);
  assert.equal(isRetryableOpenReceiveErrorCode("TIMEOUT"), true);
  assert.equal(isRetryableOpenReceiveErrorCode("INVALID_REQUEST"), false);

  const error = new OpenReceiveError({
    code: "TIMEOUT",
    message: "Wallet request timed out",
    retryable: true,
    request_id: "req_123",
    details: {
      relay: "wss://relay.example.com",
    },
  });

  assert.deepEqual(error.toJSON(), {
    code: "TIMEOUT",
    message: "Wallet request timed out",
    retryable: true,
    request_id: "req_123",
    details: {
      relay: "wss://relay.example.com",
    },
  });
});

test("settlement detection ignores preimage without settled state", () => {
  const detection = classifyTransactionSettlement({
    payment_hash: PAYMENT_HASH,
    preimage: "d".repeat(64),
    state: "pending",
  });

  assert.equal(detection.settled, false);
  assert.equal(detection.status, "pending");
  assert.equal(detection.preimage_present, true);
});

test("sweepPendingInvoicesOnce walks a global temporal cursor and catches bottom settlements", async () => {
  const store = new InMemoryInvoiceKvStore();
  const transactions = [];
  const settledIndexes = new Set([0, 2, 4]);
  for (let index = 0; index < 30; index += 1) {
    const paymentHash = index.toString(16).padStart(64, "0");
    const invoiceId = `or_inv_page_${index}`;
    const invoice = `lnbc-page-${index}`;
    await store.putIfAbsent(
      seedRecord({
        invoice_id: invoiceId,
        idempotency_key: `order-page-${index}`,
        payment_hash: paymentHash,
        invoice,
        created_at: 1000 + index,
        expires_at: 3000,
      }),
    );
    transactions.push({
      type: "incoming",
      invoice,
      payment_hash: paymentHash,
      state: settledIndexes.has(index) ? "settled" : "pending",
      created_at: 1000 + index,
      ...(settledIndexes.has(index) ? { settled_at: 2100 + index } : {}),
    });
  }

  let now = 2000;
  const requests = [];
  const paid = [];
  const client = {
    async preflight() {
      throw new Error("preflight is not needed by status refresh");
    },
    async makeInvoice() {
      throw new Error("makeInvoice is not needed by status refresh");
    },
    async listTransactions(request) {
      requests.push(request);
      return {
        transactions: temporalTransactionPage(transactions, request),
      };
    },
  };

  const first = await sweepPendingInvoicesOnce({
    store,
    client,
    clock: () => now,
    settlementAction: async ({ invoice }) => {
      paid.push(invoice.invoice_id);
    },
  });
  assert.equal(first.swept, true);
  assert.equal(first.page_count, 25);
  assert.deepEqual(requests.at(-1), {
    type: "incoming",
    unpaid: true,
    from: 940,
    until: 2000,
    limit: 25,
  });
  assert.equal("offset" in requests.at(-1), false);
  assert.deepEqual(JSON.parse((await store.getMeta(TRANSACTION_SCAN_CURSOR_KEY)).value), {
    until_cursor: 1005,
    last_swept_at: 2000,
  });
  assert.deepEqual(paid, []);

  now = 2012;
  const second = await sweepPendingInvoicesOnce({
    store,
    client,
    clock: () => now,
    settlementAction: async ({ invoice }) => {
      paid.push(invoice.invoice_id);
    },
  });
  assert.equal(second.swept, true);
  assert.equal(second.page_count, 6);
  assert.equal(requests.at(-1).until, 1005);
  assert.deepEqual(JSON.parse((await store.getMeta(TRANSACTION_SCAN_CURSOR_KEY)).value), {
    until_cursor: 2012,
    last_swept_at: 2012,
  });
  assert.deepEqual(paid.sort(), ["or_inv_page_0", "or_inv_page_2", "or_inv_page_4"]);

  for (const index of settledIndexes) {
    const stored = await store.get(`or_inv_page_${index}`);
    assert.equal(stored.row.transaction_state, "settled");
    assert.equal(stored.row.workflow_state, "settlement_action_completed");
  }
});

test("sweepPendingInvoicesOnce does not advance cursor after wallet scan failure", async () => {
  const store = new InMemoryInvoiceKvStore();
  await store.putIfAbsent(
    seedRecord({
      invoice_id: "or_inv_scan_failure",
      idempotency_key: "order-scan-failure",
      payment_hash: PAYMENT_HASH,
      invoice: "lnbc-scan-failure",
      expires_at: 3000,
    }),
  );

  let now = 1000;
  let fail = true;
  const requests = [];
  const client = {
    async preflight() {
      throw new Error("preflight is not needed by status refresh");
    },
    async makeInvoice() {
      throw new Error("makeInvoice is not needed by status refresh");
    },
    async listTransactions(request) {
      requests.push(request);
      if (fail) throw new Error("wallet unavailable");
      return { transactions: [] };
    },
  };

  const failed = await sweepPendingInvoicesOnce({
    store,
    client,
    clock: () => now,
  });
  assert.equal(failed.swept, false);
  assert.equal(failed.reason, "wallet_scan_failed");
  assert.equal(await store.getMeta(TRANSACTION_SCAN_CURSOR_KEY), undefined);

  fail = false;
  now = 1002;
  const retried = await sweepPendingInvoicesOnce({
    store,
    client,
    clock: () => now,
  });
  assert.equal(retried.swept, true);
  assert.equal(retried.page_count, 0);
  assert.deepEqual(
    requests.map((request) => request.offset),
    [undefined, undefined],
  );
  assert.deepEqual(JSON.parse((await store.getMeta(TRANSACTION_SCAN_CURSOR_KEY)).value), {
    until_cursor: 1002,
    last_swept_at: 1002,
  });
});

test("sweepPendingInvoicesOnce ignores new top growth while continuing an older cursor window", async () => {
  const store = new InMemoryInvoiceKvStore();
  const transactions = [];
  for (let index = 0; index < 30; index += 1) {
    const paymentHash = index.toString(16).padStart(64, "0");
    const invoiceId = `or_inv_growth_${index}`;
    const invoice = `lnbc-growth-${index}`;
    await store.putIfAbsent(
      seedRecord({
        invoice_id: invoiceId,
        idempotency_key: `order-growth-${index}`,
        payment_hash: paymentHash,
        invoice,
        created_at: 1000 + index,
        expires_at: 3000,
      }),
    );
    transactions.push({
      type: "incoming",
      invoice,
      payment_hash: paymentHash,
      state: "pending",
      created_at: 1000 + index,
    });
  }

  let now = 2000;
  const requests = [];
  const client = {
    async preflight() {
      throw new Error("preflight is not needed by status refresh");
    },
    async makeInvoice() {
      throw new Error("makeInvoice is not needed by status refresh");
    },
    async listTransactions(request) {
      requests.push(request);
      return {
        transactions: temporalTransactionPage(transactions, request),
      };
    },
  };

  await sweepPendingInvoicesOnce({ store, client, clock: () => now });
  assert.deepEqual(JSON.parse((await store.getMeta(TRANSACTION_SCAN_CURSOR_KEY)).value), {
    until_cursor: 1005,
    last_swept_at: 2000,
  });

  for (let index = 30; index < 35; index += 1) {
    const paymentHash = index.toString(16).padStart(64, "0");
    const invoiceId = `or_inv_growth_${index}`;
    const invoice = `lnbc-growth-${index}`;
    await store.putIfAbsent(
      seedRecord({
        invoice_id: invoiceId,
        idempotency_key: `order-growth-${index}`,
        payment_hash: paymentHash,
        invoice,
        created_at: 2000 + index,
        expires_at: 4000,
      }),
    );
    transactions.push({
      type: "incoming",
      invoice,
      payment_hash: paymentHash,
      state: "pending",
      created_at: 2000 + index,
    });
  }
  const target = transactions.find((transaction) => transaction.invoice === "lnbc-growth-4");
  target.state = "settled";
  target.settled_at = 2010;

  now = 2002;
  await sweepPendingInvoicesOnce({ store, client, clock: () => now });

  assert.equal(requests.at(-1).until, 1005);
  assert.equal(requests.at(-1).offset, undefined);
  const stored = await store.get("or_inv_growth_4");
  assert.equal(stored.row.transaction_state, "settled");
  assert.equal(stored.row.settled_at, 2010);
});

test("sweepPendingInvoicesOnce performs no wallet call for an empty open set", async () => {
  const store = new InMemoryInvoiceKvStore();
  let calls = 0;
  const client = {
    async preflight() {
      throw new Error("preflight is not needed by status refresh");
    },
    async makeInvoice() {
      throw new Error("makeInvoice is not needed by status refresh");
    },
    async listTransactions() {
      calls += 1;
      return { transactions: [] };
    },
  };

  const result = await sweepPendingInvoicesOnce({ store, client, clock: () => 1000 });

  assert.equal(result.swept, false);
  assert.equal(result.reason, "no_pending");
  assert.equal(calls, 0);
});

test("sweepPendingInvoicesOnce performs no wallet call when only expired invoices remain", async () => {
  const store = new InMemoryInvoiceKvStore();
  await store.putIfAbsent(
    seedRecord({
      invoice_id: "or_inv_expired_scan_skip",
      idempotency_key: "order-expired-scan-skip",
      invoice: "lnbc-expired-scan-skip",
      expires_at: 1000,
    }),
  );
  let calls = 0;
  const client = {
    async preflight() {
      throw new Error("preflight is not needed by status refresh");
    },
    async makeInvoice() {
      throw new Error("makeInvoice is not needed by status refresh");
    },
    async listTransactions() {
      calls += 1;
      return { transactions: [] };
    },
  };

  const result = await sweepPendingInvoicesOnce({ store, client, clock: () => 1000 });

  assert.equal(result.swept, false);
  assert.equal(result.reason, "no_pending");
  assert.equal(calls, 0);
});

test("sweepPendingInvoicesOnce durable gate prevents request storms", async () => {
  const store = new InMemoryInvoiceKvStore();
  await store.putIfAbsent(
    seedRecord({
      invoice_id: "or_inv_gate",
      idempotency_key: "order-gate",
      invoice: "lnbc-gate",
      expires_at: 3000,
    }),
  );

  let calls = 0;
  const client = {
    async preflight() {
      throw new Error("preflight is not needed by status refresh");
    },
    async makeInvoice() {
      throw new Error("makeInvoice is not needed by status refresh");
    },
    async listTransactions() {
      calls += 1;
      return { transactions: [] };
    },
  };
  const [first, second] = await Promise.all([
    sweepPendingInvoicesOnce({ store, client, clock: () => 1000 }),
    sweepPendingInvoicesOnce({ store, client, clock: () => 1000 }),
  ]);

  assert.equal(calls, 1);
  assert.equal([first.swept, second.swept].filter(Boolean).length, 1);
  assert.equal([first.reason, second.reason].includes("gate_busy"), true);
});

test("sweepPendingInvoicesOnce backs off to six seconds when all open invoices are older than two minutes", async () => {
  const store = new InMemoryInvoiceKvStore();
  await store.putIfAbsent(
    seedRecord({
      invoice_id: "or_inv_mid_gate_1",
      idempotency_key: "order-mid-gate-1",
      payment_hash: "1".repeat(64),
      invoice: "lnbc-mid-gate-1",
      created_at: 1000,
      expires_at: 3000,
    }),
  );
  await store.putIfAbsent(
    seedRecord({
      invoice_id: "or_inv_mid_gate_2",
      idempotency_key: "order-mid-gate-2",
      payment_hash: "2".repeat(64),
      invoice: "lnbc-mid-gate-2",
      created_at: 1010,
      expires_at: 3000,
    }),
  );

  let now = 1131;
  let calls = 0;
  const client = {
    async preflight() {
      throw new Error("preflight is not needed by status refresh");
    },
    async makeInvoice() {
      throw new Error("makeInvoice is not needed by status refresh");
    },
    async listTransactions() {
      calls += 1;
      return { transactions: [] };
    },
  };

  const first = await sweepPendingInvoicesOnce({ store, client, clock: () => now });
  now = 1136;
  const second = await sweepPendingInvoicesOnce({ store, client, clock: () => now });
  now = 1137;
  const third = await sweepPendingInvoicesOnce({ store, client, clock: () => now });

  assert.equal(first.swept, true);
  assert.equal(second.swept, false);
  assert.equal(second.reason, "gate_busy");
  assert.equal(third.swept, true);
  assert.equal(calls, 2);
});

test("sweepPendingInvoicesOnce keeps two second cadence while any open invoice is young", async () => {
  const store = new InMemoryInvoiceKvStore();
  await store.putIfAbsent(
    seedRecord({
      invoice_id: "or_inv_mixed_gate_old",
      idempotency_key: "order-mixed-gate-old",
      payment_hash: "3".repeat(64),
      invoice: "lnbc-mixed-gate-old",
      created_at: 1000,
      expires_at: 3000,
    }),
  );
  await store.putIfAbsent(
    seedRecord({
      invoice_id: "or_inv_mixed_gate_young",
      idempotency_key: "order-mixed-gate-young",
      payment_hash: "4".repeat(64),
      invoice: "lnbc-mixed-gate-young",
      created_at: 1417,
      expires_at: 3000,
    }),
  );

  let now = 1420;
  let calls = 0;
  const client = {
    async preflight() {
      throw new Error("preflight is not needed by status refresh");
    },
    async makeInvoice() {
      throw new Error("makeInvoice is not needed by status refresh");
    },
    async listTransactions() {
      calls += 1;
      return { transactions: [] };
    },
  };

  const first = await sweepPendingInvoicesOnce({ store, client, clock: () => now });
  now = 1421;
  const second = await sweepPendingInvoicesOnce({ store, client, clock: () => now });
  now = 1422;
  const third = await sweepPendingInvoicesOnce({ store, client, clock: () => now });

  assert.equal(first.swept, true);
  assert.equal(second.swept, false);
  assert.equal(second.reason, "gate_busy");
  assert.equal(third.swept, true);
  assert.equal(calls, 2);
});

test("sweepPendingInvoicesOnce backs off to twelve seconds when all open invoices are older than five minutes", async () => {
  const store = new InMemoryInvoiceKvStore();
  await store.putIfAbsent(
    seedRecord({
      invoice_id: "or_inv_late_gate_1",
      idempotency_key: "order-late-gate-1",
      payment_hash: "5".repeat(64),
      invoice: "lnbc-late-gate-1",
      created_at: 1000,
      expires_at: 3000,
    }),
  );
  await store.putIfAbsent(
    seedRecord({
      invoice_id: "or_inv_late_gate_2",
      idempotency_key: "order-late-gate-2",
      payment_hash: "6".repeat(64),
      invoice: "lnbc-late-gate-2",
      created_at: 1010,
      expires_at: 3000,
    }),
  );

  let now = 1320;
  let calls = 0;
  const client = {
    async preflight() {
      throw new Error("preflight is not needed by status refresh");
    },
    async makeInvoice() {
      throw new Error("makeInvoice is not needed by status refresh");
    },
    async listTransactions() {
      calls += 1;
      return { transactions: [] };
    },
  };

  const first = await sweepPendingInvoicesOnce({ store, client, clock: () => now });
  now = 1331;
  const second = await sweepPendingInvoicesOnce({ store, client, clock: () => now });
  now = 1332;
  const third = await sweepPendingInvoicesOnce({ store, client, clock: () => now });

  assert.equal(first.swept, true);
  assert.equal(second.swept, false);
  assert.equal(second.reason, "gate_busy");
  assert.equal(third.swept, true);
  assert.equal(calls, 2);
});

test("sweepPendingInvoicesOnce caps list_transactions page size at fifty", async () => {
  const store = new InMemoryInvoiceKvStore();
  await store.putIfAbsent(
    seedRecord({
      invoice_id: "or_inv_scan_limit",
      idempotency_key: "order-scan-limit",
      payment_hash: PAYMENT_HASH,
      invoice: "lnbc-scan-limit",
      expires_at: 3000,
    }),
  );

  const requests = [];
  const client = {
    async preflight() {
      throw new Error("preflight is not needed by status refresh");
    },
    async makeInvoice() {
      throw new Error("makeInvoice is not needed by status refresh");
    },
    async listTransactions(request) {
      requests.push(request);
      return { transactions: [] };
    },
  };

  await sweepPendingInvoicesOnce({
    store,
    client,
    clock: () => 1000,
    transactionScanPageLimit: 500,
  });

  assert.equal(requests[0].limit, 50);
});

test("in-memory KV storage replays same idempotency request and conflicts on drift", async () => {
  const store = new InMemoryInvoiceKvStore();
  const firstHash = await createIdempotencyRequestHash({ amount_msats: 200000 });
  const secondHash = await createIdempotencyRequestHash({ amount_msats: 300000 });
  const record = seedRecord({
    idempotency_request_hash: firstHash,
  });

  assert.equal((await putCreatedInvoiceRecord({ store, record })).status, "created");
  assert.equal((await putCreatedInvoiceRecord({ store, record })).status, "replayed");
  await assert.rejects(
    () =>
      getIdempotentRecord({
        store,
        scope: record.row,
        idempotency_request_hash: secondHash,
      }),
    /different request body/,
  );
});

test("browser helpers create lightning URI, copy, open, and QR payloads", async () => {
  const writes = [];
  const opens = [];
  const encoder = {
    toString: async (payload, options) => {
      assert.equal(payload, "lightning:lnbc-test");
      assert.equal(options.margin, 4);
      assert.equal(options.color.light, "#FFFFFFFF");
      return "<svg></svg>";
    },
  };

  assert.equal(createLightningUri("lnbc-test"), "lightning:lnbc-test");
  assert.equal(await createQrSvg("lnbc-test", { encoder }), "<svg></svg>");
  await copyInvoice({
    invoice: "lnbc-test",
    clipboard: {
      writeText: async (value) => writes.push(value),
    },
  });
  assert.deepEqual(writes, ["lnbc-test"]);
  assert.equal(
    openWallet({
      invoice: "lnbc-test",
      open: (uri) => opens.push(uri),
    }),
    "lightning:lnbc-test",
  );
  assert.deepEqual(opens, ["lightning:lnbc-test"]);
});

test("browser owns checkout display-safe labels", () => {
  const model = createCheckoutDisplayModel({
    rail: "lightning",
    invoice: "lnbc-display",
    payment_hash: "a".repeat(64),
    amount_msats: 200000,
    fiat_quote: {
      fiat: {
        currency: "USD",
        value: "0.05",
      },
    },
    transaction_state: "pending",
  });

  assert.equal(model.lightning_uri, "lightning:lnbc-display");
  assert.equal(model.amountLabel, "200 sats");
  assert.equal(model.fiatLabel, "$0.05");
  assert.equal(model.paymentHashLabel, "aaaaaaaa...aaaaaaaa");
  assert.equal(model.transactionStateLabel, "pending");
  assert.equal(formatOpenReceivePaymentHashLabel("short-hash"), "short-hash");
  assert.throws(
    () => assertOpenReceiveDisplayInvoice("nostr+walletconnect://secret"),
    /must not be an NWC/,
  );
});

test("browser owns display HTML escaping for string-rendered adapters", () => {
  assert.equal(escapeOpenReceiveHtml(`<&>"invoice"`), "&lt;&amp;&gt;&quot;invoice&quot;");
});

test("browser owns checkout display data to state conversion", () => {
  const displayData = {
    invoice_id: "or_inv_display_state",
    rail: "lightning",
    invoice: "lnbc-display-state",
    payment_hash: "b".repeat(64),
    amount_msats: 21000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: 2000,
    settled_at: 1999,
  };

  const snapshot = createCheckoutSnapshotFromDisplayData(displayData);
  assert.equal(snapshot.checkout_id, "or_inv_display_state");
  assert.equal(snapshot.status, "paid");
  assert.equal(snapshot.paid_at, 1999);
  assert.deepEqual(snapshot.invoices[0], displayData);

  const state = createCheckoutStateFromDisplayData(displayData, {
    now: 1940,
  });
  assert.equal(state.invoice_id, "or_inv_display_state");
  assert.equal(state.lightning_uri, "lightning:lnbc-display-state");
  assert.equal(state.amount_msats, 21000);
  assert.equal(state.phase, "settled");
  assert.equal(state.expires_in_seconds, 60);
  assert.equal(state.settled_at, 1999);
  const defaultClockState = createCheckoutStateFromDisplayData({
    ...displayData,
    expires_at: Math.floor(Date.now() / 1000) + 30,
  });
  assert.equal(defaultClockState.expires_in_seconds !== undefined, true);
  assert.equal(defaultClockState.expires_in_seconds <= 30, true);
  assert.equal(defaultClockState.expires_in_seconds >= 0, true);

  assert.throws(
    () =>
      createCheckoutSnapshotFromDisplayData({
        rail: "lightning",
        invoice: "lnbc-no-id",
      }),
    /requires invoice_id/,
  );
});

test("browser preserves swap invoices while keeping Lightning active", async () => {
  const displayInvoice = {
    invoice_id: "or_inv_display_swap",
    rail: "lightning",
    invoice: "lnbc-display-swap",
    payment_hash: "d".repeat(64),
    amount_msats: 200000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: 1600,
  };
  const swapInvoice = {
    invoice_id: "or_inv_shadow_swap",
    rail: "swap",
    invoice: null,
    payment_hash: "e".repeat(64),
    amount_msats: 200000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: 2800,
    swap: {
      attempt_id: "or_inv_shadow_swap",
      provider: "fixedfloat",
      provider_order_id: "ff-order-1",
      pay_in_asset: "USDT_TRON",
      deposit_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
      deposit_amount: "1.05",
      provider_state: "awaiting_deposit",
      provider_expires_at: 1590,
    },
  };
  const refresh = createOpenReceiveStatusFetcher({
    orderUrl: "/order",
    fetch: async () =>
      new Response(
        JSON.stringify({
          checkout_id: "or_chk_swap_browser",
          order_id: "order-swap-browser",
          status: "open",
          amount_msats: 200000,
          active: displayInvoice,
          invoices: [swapInvoice, displayInvoice],
        }),
        { status: 200 },
      ),
  });

  const snapshot = await refresh("order-swap-browser");
  assert.equal(snapshot.active.invoice_id, "or_inv_display_swap");
  assert.equal(snapshot.invoices[0].rail, "swap");
  assert.equal(snapshot.invoices[0].invoice, undefined);
  assert.equal(snapshot.invoices[0].swap.provider, "fixedfloat");
  assert.equal(snapshot.invoices[0].swap.attempt_id, "or_inv_shadow_swap");
  assert.equal("provider_token" in snapshot.invoices[0].swap, false);

  const state = createCheckoutState(snapshot, { now: 1000 });
  assert.equal(state.invoice_id, "or_inv_display_swap");
  assert.equal(state.rail, "lightning");
  assert.equal(state.invoice, "lnbc-display-swap");
});

test("browser owns checkout payment status display model", () => {
  const state = createCheckoutState(
    {
      ...checkoutSnapshot({
        invoice_id: "or_inv_status",
        invoice: "lnbc-status",
        transaction_state: "pending",
        workflow_state: "verifying",
        expires_at: 1065,
      }),
    },
    {
      now: 1000,
    },
  );

  const status = createCheckoutStatusModel(state, { now: 1000 });
  assert.equal(status.phase, "verifying");
  assert.equal(status.waiting, true);
  assert.equal(status.title, "Waiting for payment");
  assert.equal(status.detail, "Keep this page open while we verify settlement.");
  assert.equal(status.countdownPrefix, "Invoice expires in");
  assert.equal(status.expires_in_seconds, 65);
  assert.equal(status.countdownLabel, "1:05");

  const settled = createCheckoutStatusModel({
    ...state,
    transaction_state: "settled",
    workflow_state: "settlement_action_completed",
    phase: "settled",
    settled: true,
    terminal: false,
    expires_in_seconds: undefined,
  });
  assert.equal(settled.waiting, false);
  assert.equal(settled.title, "Payment received");
  assert.equal(settled.countdownLabel, undefined);

  const lightweight = createCheckoutStatusModel({
    phase: "expired",
    waiting: false,
    expires_in_seconds: 0,
  });
  assert.equal(lightweight.title, "Invoice expired");
  assert.equal(lightweight.countdownLabel, undefined);

  const zeroCountdown = createCheckoutStatusModel({
    ...state,
    expires_in_seconds: 0,
  });
  assert.equal(zeroCountdown.phase, "expired");
  assert.equal(zeroCountdown.waiting, false);
  assert.equal(zeroCountdown.title, "Invoice expired");
  assert.equal(zeroCountdown.countdownLabel, undefined);
});

test("browser owns reusable checkout attribute parsers", () => {
  assert.equal(parseOpenReceiveOptionalInteger(null), undefined);
  assert.equal(parseOpenReceiveOptionalInteger(""), undefined);
  assert.equal(parseOpenReceiveOptionalInteger("123", { label: "amount-msats" }), 123);
  assert.throws(
    () => parseOpenReceiveOptionalInteger("-1", { label: "expires-at" }),
    /expires-at must be a non-negative safe integer/,
  );
  assert.equal(parseOpenReceiveBooleanAttribute(null), undefined);
  assert.equal(parseOpenReceiveBooleanAttribute("false"), false);
  assert.equal(parseOpenReceiveBooleanAttribute(""), true);
  assert.equal(parseOpenReceiveResolvedTheme("dark"), "dark");
  assert.equal(parseOpenReceiveResolvedTheme("system"), undefined);
  assert.equal(parseOpenReceiveThemePreference("system"), "system");
  assert.equal(parseOpenReceiveThemePreference("sepia"), undefined);
});

test("browser owns transient copy feedback timing", () => {
  const values = [];
  const timers = new Map();
  let nextTimerId = 1;
  const controller = createOpenReceiveTransientFeedbackController({
    resetValue: "Copy invoice",
    delayMs: 20,
    setTimeout: (callback, delay) => {
      const id = nextTimerId++;
      timers.set(id, {
        callback: () => {
          timers.delete(id);
          callback();
        },
        delay,
      });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    onValue: (value) => values.push(value),
  });

  controller.show("Copied!");
  assert.deepEqual(values, ["Copied!"]);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 20);

  controller.show("Copied again!");
  assert.deepEqual(values, ["Copied!", "Copied again!"]);
  assert.equal(timers.size, 1);

  [...timers.values()][0].callback();
  assert.deepEqual(values, ["Copied!", "Copied again!", "Copy invoice"]);

  controller.show("Copied!");
  controller.clear();
  assert.equal(timers.size, 0);
});

test("browser owns shared country map geometry", () => {
  assert.equal(OPENRECEIVE_COUNTRY_MAP_WIDTH, 820);
  assert.equal(OPENRECEIVE_COUNTRY_MAP_HEIGHT, 420);
  assert.equal(OPENRECEIVE_COUNTRY_MAP_VIEW_BOX, "0 0 820 420");
  assert.deepEqual(
    openReceiveCountryMapRegions.map((region) => region.id),
    ["north-america", "latin-america", "europe", "africa", "middle-east", "asia-pacific"],
  );
  assert.equal(openReceiveCountryMapLandPaths.length > 0, true);
  assert.match(openReceiveCountryMapLandPaths[0].d, /^M/);
  const countries = [
    { code: "US", name: "United States", currency: "USD", coverage: "deep" },
    { code: "GB", name: "United Kingdom", currency: "GBP", coverage: "thin" },
  ];
  const picker = createOpenReceiveCountryPickerModel({
    countries,
    selectedCountryCode: "US",
    selectedRegion: "north-america",
    hoveredCountryCode: "GB",
  });
  assert.equal(formatOpenReceiveCountryMetaLabel(countries[0]), "USD");
  assert.equal(picker.selectedCountryDisplay?.label, "United States");
  assert.equal(picker.selectedCountryDisplay?.metaLabel, "USD");
  assert.equal(picker.hoveredCountryDisplay?.metaLabel, "GBP");
  assert.equal(picker.readoutLabel, "United Kingdom");
  assert.equal(picker.readoutMetaLabel, "GBP");
  assert.equal(picker.visibleRegionCountryDisplays[0].selected, true);
  assert.equal(picker.visibleRegionCountryDisplays[0].metaLabel, "USD");
});

test("browser owns web-component shadow styles", () => {
  assert.match(openReceiveCheckoutElementStyles, /:host/);
  assert.match(openReceiveCheckoutElementStyles, /part="wizard"/);
  assert.match(openReceiveCheckoutElementStyles, /openreceive-spin/);
  assert.match(openReceiveThemeToggleElementStyles, /data-openreceive-theme-toggle|min-height/);
});

test("browser request checkout helper posts SDK-shaped data to an app-owned URL", async () => {
  const requests = [];
  const checkout = await requestCheckout({
    checkoutUrl: "/create_order",
    orderId: "order-browser-create",
    usd: "10.00",
    memo: "Browser helper invoice",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          checkout_id: "or_chk_browser_create",
          order_id: "order-browser-create",
          status: "open",
          amount_msats: 200000,
          active: {
            invoice_id: "or_inv_browser_create",
            invoice: "lnbc-browser-create",
            rail: "lightning",
            payment_hash: PAYMENT_HASH,
            amount_msats: 200000,
            order_id: "order-browser-create",
            transaction_state: "pending",
            workflow_state: "invoice_created",
          },
          invoices: [],
        }),
      };
    },
  });

  assert.equal(checkout.checkout_id, "or_chk_browser_create");
  assert.equal(checkout.active.invoice_id, "or_inv_browser_create");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/create_order");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["Content-Type"], "application/json");
  assert.equal("Idempotency-Key" in requests[0].init.headers, false);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    order_id: "order-browser-create",
    amount: {
      fiat: {
        currency: "USD",
        value: "10.00",
      },
    },
    memo: "Browser helper invoice",
  });

  await requestCheckout({
    checkoutUrl: (orderId) => `/checkout/${orderId}`,
    orderId: "order-browser-btc",
    amount: {
      btc: {
        currency: "BTC",
        value: "0.005",
      },
    },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          checkout_id: "or_chk_browser_btc",
          order_id: "order-browser-btc",
          status: "open",
          amount_msats: 500000000,
          active: {
            invoice_id: "or_inv_browser_btc",
            invoice: "lnbc-browser-btc",
            rail: "lightning",
            payment_hash: PAYMENT_HASH,
            amount_msats: 500000000,
            order_id: "order-browser-btc",
            transaction_state: "pending",
            workflow_state: "invoice_created",
          },
          invoices: [],
        }),
      };
    },
  });
  assert.equal(requests[1].url, "/checkout/order-browser-btc");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    order_id: "order-browser-btc",
    amount: {
      btc: {
        currency: "BTC",
        value: "0.005",
      },
    },
  });

  await requestCheckout({
    checkoutUrl: "/checkout/{orderId}",
    orderId: "order-browser-sats",
    sats: 500,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          checkout_id: "or_chk_browser_sats",
          order_id: "order-browser-sats",
          status: "open",
          amount_msats: 500000,
          active: {
            invoice_id: "or_inv_browser_sats",
            invoice: "lnbc-browser-sats",
            rail: "lightning",
            payment_hash: PAYMENT_HASH,
            amount_msats: 500000,
            order_id: "order-browser-sats",
            transaction_state: "pending",
            workflow_state: "invoice_created",
          },
          invoices: [],
        }),
      };
    },
  });
  assert.equal(requests[2].url, "/checkout/order-browser-sats");
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    order_id: "order-browser-sats",
    amount: {
      btc: {
        currency: "SATS",
        value: "500",
      },
    },
  });

  await assert.rejects(
    () =>
      requestCheckout({
        checkoutUrl: "/create_order",
        orderId: "",
        amount: { btc: { currency: "BTC", value: "0.000002" } },
        fetch: async () => ({
          ok: true,
          json: async () => ({}),
        }),
      }),
    /orderId/,
  );
  await assert.rejects(
    () =>
      requestCheckout({
        checkoutUrl: "/create_order",
        orderId: "old-direct-sats",
        amount: { sats: "200" },
        fetch: async () => ({
          ok: true,
          json: async () => ({}),
        }),
      }),
    /amount\.btc or amount\.fiat/,
  );
  await assert.rejects(
    () =>
      requestCheckout({
        checkoutUrl: "/create_order",
        orderId: "old-direct-msats",
        amount: { msats: "200000" },
        fetch: async () => ({
          ok: true,
          json: async () => ({}),
        }),
      }),
    /amount\.btc or amount\.fiat/,
  );
  await assert.rejects(
    () =>
      requestCheckout({
        checkoutUrl: "/create_order",
        orderId: "bad-nwc",
        amount: { btc: { currency: "BTC", value: "0.000002" } },
        memo: `nostr+walletconnect://${"a".repeat(64)}?secret=${"b".repeat(64)}`,
        fetch: async () => ({
          ok: true,
          json: async () => ({}),
        }),
      }),
    /NWC/,
  );
  await assert.rejects(
    () =>
      requestCheckout({
        checkoutUrl: "/create_order",
        orderId: "server-error",
        amount: { btc: { currency: "BTC", value: "0.000002" } },
        fetch: async () => ({
          ok: false,
          json: async () => ({
            message: "Could not quote fiat.",
          }),
        }),
      }),
    /Could not quote fiat/,
  );
});

test("browser status fetcher owns display-safe status POST shape", async () => {
  const requests = [];
  const refreshStatus = createOpenReceiveStatusFetcher({
    orderUrl: "/order",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          order_id: "order-status",
          status: "paid",
          paid: true,
          display_checkout: checkoutSnapshot(
            {
              invoice_id: "or_inv_status",
              invoice: "lnbc-status",
              payment_hash: PAYMENT_HASH,
              transaction_state: "settled",
              workflow_state: "settlement_action_pending",
              settled_at: 1001,
            },
            {
              checkout_id: "or_chk_status",
              order_id: "order-status",
              status: "paid",
              paid_at: 1001,
            },
          ),
          checkouts: [],
          payment_methods: [
            {
              pay_in_asset: "USDT_TRON",
              label: "USDT",
              network_label: "Tron",
              provider: "fixedfloat",
              available: true,
              pay_amount: "1.05",
            },
          ],
        }),
      };
    },
  });

  const body = await refreshStatus("order-status");

  assert.equal(body.checkout_id, "or_chk_status");
  assert.equal(body.status, "paid");
  assert.equal(body.invoices[0].invoice_id, "or_inv_status");
  // Payable assets ride on the order object itself (payment_methods).
  assert.equal(body.payment_methods.length, 1);
  assert.equal(body.payment_methods[0].pay_in_asset, "USDT_TRON");
  assert.equal(body.payment_methods[0].pay_amount, "1.05");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/order");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    order_id: "order-status",
  });

  const failingStatus = createOpenReceiveStatusFetcher({
    orderUrl: "/order",
    fetch: async () => ({
      ok: false,
      json: async () => ({
        message: "Invoice not found.",
      }),
    }),
  });
  await assert.rejects(() => failingStatus("order-status"), /Invoice not found/);
});

test("browser checkout state ignores passive event and route URLs", () => {
  const logs = [];
  const logger = (entry) => logs.push(entry);
  const state = createCheckoutState(
    checkoutSnapshot({
      invoice_id: "or_inv_browser",
      invoice: "lnbc-browser",
      payment_hash: PAYMENT_HASH,
      amount_msats: 200000,
      transaction_state: "pending",
      workflow_state: "invoice_created",
      expires_at: 1030,
    }),
    { logger, now: 1000 },
  );

  assert.equal(state.lightning_uri, "lightning:lnbc-browser");
  assert.equal(state.phase, "invoice_created");
  assert.equal(state.expires_in_seconds, 30);
  assert.equal(state.terminal, false);
  assert.equal("routes_url" in state, false);
  assert.equal("events_url" in state, false);
  assert.deepEqual(
    logs.map((entry) => entry.event),
    ["checkout.state.created"],
  );
  assert.equal(logs[0].invoice_id, "or_inv_browser");
  assert.doesNotMatch(JSON.stringify(logs), /nostr\+walletconnect:\/\//);
});

test("browser checkout watcher owns countdown and status refresh polling", async () => {
  let now = 1000;
  let nextTimer = 1;
  const timers = new Map();
  const clearedTimers = [];
  const states = [];
  let statusCalls = 0;

  const watcher = new CheckoutWatcher({
    snapshot: checkoutSnapshot({
      invoice_id: "or_inv_watch",
      invoice: "lnbc-watch",
      payment_hash: PAYMENT_HASH,
      amount_msats: 200000,
      transaction_state: "pending",
      workflow_state: "invoice_created",
      expires_at: 1010,
    }),
    now: () => now,
    setInterval: (callback, ms) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearInterval: (id) => {
      clearedTimers.push(id);
      timers.delete(id);
    },
    refreshStatus: async (order_id) => {
      statusCalls += 1;
      assert.equal(order_id, "order_or_inv_watch");
      return checkoutSnapshot(
        {
          invoice_id: "or_inv_watch",
          invoice: "lnbc-watch",
          payment_hash: PAYMENT_HASH,
          transaction_state: "settled",
          workflow_state: "settlement_action_pending",
          settled_at: 1002,
        },
        {
          checkout_id: "or_chk_or_inv_watch",
          order_id,
          status: "paid",
          paid_at: 1002,
        },
      );
    },
    onState: (state) => {
      states.push(state);
    },
  });

  const initial = watcher.start();
  assert.equal(initial.expires_in_seconds, 10);
  assert.equal(shouldCheckoutShowWaiting(initial, { now }), true);
  const countdownTimer = [...timers].find(([, timer]) => timer.ms === 1000);
  const pollTimer = [...timers].find(([, timer]) => timer.ms === 3000);
  assert.ok(countdownTimer);
  assert.ok(pollTimer);

  now = 1003;
  countdownTimer[1].callback();
  assert.equal(states.at(-1).expires_in_seconds, 7);

  pollTimer[1].callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(statusCalls, 1);
  assert.equal(states.at(-1).phase, "settled");
  assert.equal(shouldCheckoutShowWaiting(states.at(-1), { now }), false);
  assert.equal(timers.has(countdownTimer[0]), false);
  assert.equal(timers.has(pollTimer[0]), false);
  assert.ok(clearedTimers.includes(countdownTimer[0]));
  assert.ok(clearedTimers.includes(pollTimer[0]));
  watcher.stop();
});

test("browser checkout watcher stops polling once the invoice expires by time", async () => {
  let now = 1000;
  let nextTimer = 1;
  const timers = new Map();
  const clearedTimers = [];
  const states = [];
  let statusCalls = 0;

  const watcher = new CheckoutWatcher({
    snapshot: checkoutSnapshot({
      invoice_id: "or_inv_watch_expiry",
      invoice: "lnbc-watch-expiry",
      payment_hash: PAYMENT_HASH,
      amount_msats: 200000,
      transaction_state: "pending",
      workflow_state: "invoice_created",
      expires_at: 1002,
    }),
    now: () => now,
    setInterval: (callback, ms) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearInterval: (id) => {
      clearedTimers.push(id);
      timers.delete(id);
    },
    refreshStatus: async () => {
      statusCalls += 1;
      return null;
    },
    onState: (state) => {
      states.push(state);
    },
  });

  const initial = watcher.start();
  assert.equal(initial.expires_in_seconds, 2);
  const countdownTimer = [...timers].find(([, timer]) => timer.ms === 1000);
  const pollTimer = [...timers].find(([, timer]) => timer.ms === 3000);
  assert.ok(countdownTimer);
  assert.ok(pollTimer);

  now = 1002;
  countdownTimer[1].callback();

  assert.equal(states.at(-1).phase, "expired");
  assert.equal(states.at(-1).terminal, true);
  assert.equal(statusCalls, 0);
  assert.equal(timers.has(countdownTimer[0]), false);
  assert.equal(timers.has(pollTimer[0]), false);
  assert.ok(clearedTimers.includes(countdownTimer[0]));
  assert.ok(clearedTimers.includes(pollTimer[0]));
});

test("browser checkout controller owns lifecycle actions for framework adapters", async () => {
  const states = [];
  const writes = [];
  const opens = [];
  let statusCalls = 0;
  const controller = createCheckoutController({
    snapshot: checkoutSnapshot({
      invoice_id: "or_inv_controller",
      invoice: "lnbc-controller",
      payment_hash: PAYMENT_HASH,
      amount_msats: 200000,
      transaction_state: "pending",
      workflow_state: "invoice_created",
    }),
    refreshStatus: async (order_id) => {
      statusCalls += 1;
      assert.equal(order_id, "order_or_inv_controller");
      return checkoutSnapshot(
        {
          invoice_id: "or_inv_controller",
          invoice: "lnbc-controller",
          payment_hash: PAYMENT_HASH,
          amount_msats: 200000,
          transaction_state: "settled",
          workflow_state: "settlement_action_pending",
          settled_at: 1042,
        },
        {
          checkout_id: "or_chk_or_inv_controller",
          order_id,
          status: "paid",
          paid_at: 1042,
        },
      );
    },
    clipboard: {
      writeText: async (value) => writes.push(value),
    },
    open: (uri) => opens.push(uri),
    onState: (state) => states.push(state),
  });

  const initial = controller.start();
  assert.equal(initial.invoice_id, "or_inv_controller");
  assert.equal(controller.getState()?.phase, "invoice_created");

  await controller.copyInvoice();
  const uri = controller.openWallet();
  assert.deepEqual(writes, ["lnbc-controller"]);
  assert.deepEqual(opens, ["lightning:lnbc-controller"]);
  assert.equal(uri, "lightning:lnbc-controller");

  const reloaded = await controller.reloadState();
  assert.equal(statusCalls, 1);
  assert.equal(reloaded.phase, "settled");
  assert.equal(reloaded.settled_at, 1042);
  assert.equal(states.at(-1).settled_at, 1042);

  const retried = await controller.retry();
  assert.equal(statusCalls, 2);
  assert.equal(retried.phase, "settled");

  const cancelled = controller.cancel();
  assert.equal(cancelled.phase, "settled");

  const next = controller.update({
    snapshot: checkoutSnapshot(
      {
        invoice_id: "or_inv_controller_2",
        invoice: "lnbc-controller-2",
        payment_hash: PAYMENT_HASH,
        transaction_state: "settled",
        workflow_state: "settlement_action_pending",
        settled_at: 1000,
      },
      { status: "paid", paid_at: 1000 },
    ),
    clipboard: {
      writeText: async (value) => writes.push(value),
    },
    open: (value) => opens.push(value),
    onState: (state) => states.push(state),
  });
  assert.equal(next.invoice_id, "or_inv_controller_2");
  assert.equal(next.phase, "settled");
  await controller.copyInvoice();
  assert.deepEqual(writes, ["lnbc-controller", "lnbc-controller-2"]);
  assert.equal(states.at(-1).invoice_id, "or_inv_controller_2");
  controller.stop();
});

test("browser checkout controller owns orderUrl fetcher creation", async () => {
  let nextTimer = 1;
  const timers = new Map();
  const states = [];
  const controller = createCheckoutController({
    snapshot: checkoutSnapshot(
      {
        invoice_id: "or_inv_controller_status",
        invoice: "lnbc-controller-status",
        payment_hash: PAYMENT_HASH,
        transaction_state: "pending",
        workflow_state: "invoice_created",
      },
      { order_id: "order-controller-status" },
    ),
    orderUrl: "/order",
    fetch: async (url, init) => {
      assert.equal(url, "/order");
      assert.deepEqual(JSON.parse(init.body), {
        order_id: "order-controller-status",
      });
      return {
        ok: true,
        json: async () => ({
          paid_checkout: checkoutSnapshot(
            {
              invoice_id: "or_inv_controller_status",
              invoice: "lnbc-controller-status",
              payment_hash: PAYMENT_HASH,
              transaction_state: "settled",
              workflow_state: "settlement_action_pending",
              settled_at: 1000,
            },
            {
              checkout_id: "or_chk_or_inv_controller_status",
              order_id: "order-controller-status",
              status: "paid",
              paid_at: 1000,
            },
          ),
        }),
      };
    },
    setInterval: (callback, ms) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id);
    },
    onState: (state) => states.push(state),
  });

  controller.start();
  const pollTimer = [...timers.values()].find((timer) => timer.ms === 3000);
  assert.ok(pollTimer);
  pollTimer.callback();
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
  assert.equal(states.at(-1).phase, "settled");
  controller.stop();
});

test("browser action logs are display-safe and redact accidental secrets", async () => {
  const logs = [];
  const logger = (entry) => logs.push(entry);
  const writes = [];
  const opens = [];

  await copyInvoice({
    invoice: "lnbc-action",
    clipboard: {
      writeText: async (value) => writes.push(value),
    },
    logger,
    logContext: {
      invoice_id: "or_inv_action",
      payment_hash: PAYMENT_HASH,
    },
  });
  openWallet({
    invoice: "lnbc-action",
    open: (uri) => opens.push(uri),
    logger,
    logContext: {
      invoice_id: "or_inv_action",
      nwc_secret: `nostr+walletconnect://${"d".repeat(64)}?secret=${"e".repeat(64)}`,
    },
  });

  assert.deepEqual(writes, ["lnbc-action"]);
  assert.deepEqual(opens, ["lightning:lnbc-action"]);
  assert.deepEqual(
    logs.map((entry) => entry.event),
    ["checkout.invoice.copied", "checkout.wallet.opened"],
  );
  assert.equal(logs[0].invoice_id, "or_inv_action");
  assert.equal(logs[1].nwc_secret, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(logs), /nostr\+walletconnect:\/\//);
  assert.doesNotMatch(JSON.stringify(logs), /e{64}/);
});

test("browser custom-element event map covers checkout lifecycle events", () => {
  assert.deepEqual(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS, {
    copy: "openreceive-copy",
    openWallet: "openreceive-open-wallet",
    state: "openreceive-state",
    settled: "openreceive-settled",
    providerCopy: "openreceive-provider-copy",
    startOver: "openreceive-start-over",
    error: "openreceive-error",
  });
  const providerCopyEvent = createCheckoutProviderCopyEvent("boltz");
  assert.equal(providerCopyEvent.type, OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.providerCopy);
  assert.deepEqual(providerCopyEvent.detail, {
    providerId: "boltz",
  });
  assert.equal(
    createCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy).type,
    OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy,
  );
  assert.equal(
    createCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.startOver).type,
    OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.startOver,
  );
  const stateEventState = createCheckoutState(
    checkoutSnapshot(
      {
        invoice_id: "or_inv_event",
        invoice: "lnbc-event",
        payment_hash: PAYMENT_HASH,
        transaction_state: "settled",
        workflow_state: "settlement_action_pending",
      },
      { status: "paid" },
    ),
  );
  const stateEvent = createCheckoutStateEvent(
    OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled,
    stateEventState,
  );
  assert.equal(stateEvent.type, OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled);
  assert.deepEqual(stateEvent.detail, {
    state: stateEventState,
  });
  const error = new Error("boom");
  const errorEvent = createCheckoutErrorEvent(error);
  assert.equal(errorEvent.type, OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.error);
  assert.deepEqual(errorEvent.detail, {
    error,
  });
  assert.deepEqual(OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS, {
    change: "openreceive-theme-change",
  });
  const themeChangeEvent = createOpenReceiveThemeChangeEvent(createOpenReceiveThemeModel("dark"));
  assert.equal(themeChangeEvent.type, OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS.change);
  assert.deepEqual(themeChangeEvent.detail, {
    theme: "dark",
    resolvedTheme: "dark",
  });
});

test("browser owns payment wizard DOM contract", () => {
  assert.deepEqual(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES, {
    root: "data-openreceive-wizard",
    breadcrumb: "data-or-breadcrumb",
    method: "data-or-method",
    region: "data-or-region",
    regionShape: "data-or-region-shape",
    country: "data-or-country",
    switchCountry: "data-or-switch-country",
    route: "data-or-route",
    swapStart: "data-or-swap-start",
    swapBack: "data-or-swap-back",
    swapQr: "data-or-swap-qr",
    swapCopy: "data-or-swap-copy",
    swapRefundForm: "data-or-swap-refund-form",
    swapRefundAddress: "data-or-swap-refund-address",
    swapRefundNonce: "data-or-swap-refund-nonce",
    swapRefundConfirm: "data-or-swap-refund-confirm",
    providerCopy: "data-or-provider-copy",
    providerTutorial: "data-or-provider-tutorial",
    providerTutorialIndex: "data-or-provider-tutorial-index",
  });
  assert.equal(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.breadcrumb, "[data-or-breadcrumb]");
  assert.equal(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.method, "[data-or-method]");
  assert.equal(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapStart, "[data-or-swap-start]");
  assert.equal(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapCopy, "[data-or-swap-copy]");
  assert.equal(
    OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapRefundForm,
    "[data-or-swap-refund-form]",
  );
  assert.equal(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.providerCopy, "[data-or-provider-copy]");
  assert.equal(
    OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.providerTutorial,
    "[data-or-provider-tutorial]",
  );
  assert.equal(parseOpenReceivePaymentMethod("bitcoin"), "bitcoin");
  assert.equal(parseOpenReceivePaymentMethod("wire"), null);
  assert.equal(parseOpenReceiveRegion("europe"), "europe");
  assert.equal(parseOpenReceiveRegion("antarctica"), null);
});

test("browser owns checkout data attribute contract", () => {
  assert.deepEqual(OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES, {
    root: "data-openreceive-checkout",
    qr: "data-openreceive-qr",
    meta: "data-openreceive-meta",
    state: "data-openreceive-state",
    actions: "data-openreceive-actions",
    theme: "data-openreceive-theme",
    themeToggle: "data-openreceive-theme-toggle",
  });
  assert.equal(OPENRECEIVE_CHECKOUT_DATA_SELECTORS.root, "[data-openreceive-checkout]");
  assert.equal(OPENRECEIVE_CHECKOUT_DATA_SELECTORS.qr, "[data-openreceive-qr]");
  assert.equal(OPENRECEIVE_CHECKOUT_DATA_SELECTORS.themeToggle, "[data-openreceive-theme-toggle]");
});

test("browser owns custom-element attribute contracts", () => {
  assert.deepEqual(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES, {
    orderId: "order-id",
    invoiceId: "invoice-id",
    invoice: "invoice",
    rail: "rail",
    paymentHash: "payment-hash",
    amountMsats: "amount-msats",
    fiatCurrency: "fiat-currency",
    fiatValue: "fiat-value",
    status: "status",
    expiresAt: "expires-at",
    orderUrl: "order-url",
    theme: "theme",
    paymentWizard: "payment-wizard",
  });
  assert.deepEqual(OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES, {
    rootSelector: "root-selector",
    checkoutSelector: "checkout-selector",
    defaultTheme: "default-theme",
    storageKey: "storage-key",
  });
});

test("browser owns web-component shadow part contracts", () => {
  assert.deepEqual(OPENRECEIVE_CHECKOUT_ELEMENT_PARTS, {
    copy: "copy",
    open: "open",
    startOver: "start-over",
  });
  assert.deepEqual(OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS, {
    copy: '[part="copy"]',
    open: '[part="open"]',
    startOver: '[part="start-over"]',
  });
  assert.deepEqual(OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS, {
    button: "button",
  });
  assert.deepEqual(OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS, {
    button: '[part="button"]',
  });
});
