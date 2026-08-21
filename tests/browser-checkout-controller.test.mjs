import assert from "node:assert/strict";
import test from "node:test";
import {
  createCheckoutController,
  createCheckoutElementAttributes,
  createOpenReceiveStatusFetcher,
  createOpenReceiveSwapFeeBreakdown,
  postOpenReceiveJson,
} from "../packages/js/browser/src/internal.ts";

// The browser checkout attaches a console logger at INFO; these unit tests do not
// assert that output.
process.env.LOG_LEVEL ??= "error";

const hash = (character) => character.repeat(64);

/** Timer stubs so a started watcher never leaves a live interval behind. */
const noTimers = {
  setInterval: () => 0,
  clearInterval: () => {},
};

function lightningInvoice(overrides = {}) {
  return {
    invoice_id: hash("a"),
    rail: "lightning",
    invoice: "lnbc-light",
    payment_hash: hash("a"),
    amount_msats: 21_000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

function snapshotOf(invoices, active = invoices[0]) {
  return {
    checkout_id: active.invoice_id,
    order_id: "order-1",
    status: "open",
    amount_msats: 21_000,
    active,
    invoices,
  };
}

function jsonFetch(body) {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  fetcher.requests = requests;
  return fetcher;
}

test("status polling keeps sibling attempts so Lightning can be reused client-side", async () => {
  const lightning = lightningInvoice();
  const swap = {
    invoice_id: hash("b"),
    rail: "swap",
    payment_hash: hash("b"),
    amount_msats: 21_000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    swap: {
      provider: "fixedfloat",
      pay_in_asset: "USDT_TRON",
      deposit_address: "TDeposit",
      deposit_amount: "10.00",
      provider_state: "awaiting_deposit",
      provider_expires_at: Math.floor(Date.now() / 1000) + 900,
    },
  };
  const refresh = createOpenReceiveStatusFetcher({
    orderUrl: "/openreceive/payments/check",
    snapshot: snapshotOf([swap, lightning], swap),
    fetch: jsonFetch({ payment_hash: hash("b"), status: "pending" }),
  });

  const next = await refresh("order-1");
  assert.equal(next.active.invoice_id, hash("b"));
  assert.deepEqual(
    next.invoices.map((invoice) => invoice.invoice_id),
    [hash("b"), hash("a")],
    "the still-valid Lightning attempt must survive a swap status poll",
  );
});

test("a stopped controller reports the state its last reload produced", async () => {
  const invoice = lightningInvoice();
  let settled = false;
  const controller = createCheckoutController({
    snapshot: snapshotOf([invoice]),
    ...noTimers,
    refreshStatus: async () =>
      settled
        ? {
            ...snapshotOf([{ ...invoice, transaction_state: "settled", settled_at: 1_000 }]),
            status: "paid",
            paid_at: 1_000,
          }
        : snapshotOf([invoice]),
  });

  controller.start();
  assert.equal(controller.getState()?.settled, false);
  controller.stop();
  settled = true;

  const reloaded = await controller.reloadState();
  assert.equal(reloaded.settled, true);
  assert.equal(
    controller.getState()?.settled,
    true,
    "getState() must not serve a state older than the last reload",
  );
});

test("cancel() produces the cancelled phase it advertises", () => {
  const controller = createCheckoutController({
    snapshot: snapshotOf([lightningInvoice()]),
    ...noTimers,
    logger: false,
  });

  controller.start();
  const cancelled = controller.cancel();
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.terminal, true);
  assert.equal(cancelled.settled, false);
  assert.equal(controller.getState()?.phase, "cancelled");
  // retry() was a pure alias of reloadState() and is gone.
  assert.equal(controller.retry, undefined);
});

test("cancel() leaves a settled checkout settled", () => {
  const invoice = lightningInvoice({ transaction_state: "settled", settled_at: 1_000 });
  const controller = createCheckoutController({
    snapshot: { ...snapshotOf([invoice]), status: "paid", paid_at: 1_000 },
    ...noTimers,
    logger: false,
  });

  controller.start();
  const state = controller.cancel();
  assert.equal(state.settled, true);
  assert.equal(state.phase, "settled");
});

test("swap routes derive from the checkout status URL and never carry the action key", async () => {
  const quoteFetch = jsonFetch({ pay_in_asset: "USDT_TRON" });
  await postOpenReceiveJson(quoteFetch, "/openreceive/payments/check", {
    order_id: "order-1",
    action: "swap_quote",
    pay_in_asset: "USDT_TRON",
  });
  assert.equal(quoteFetch.requests[0].url, "/openreceive/swaps/quote");
  assert.deepEqual(quoteFetch.requests[0].body, {
    order_id: "order-1",
    pay_in_asset: "USDT_TRON",
  });

  // Anything else posts to the status URL itself — still without `action`, which
  // the shipped schemas reject as an unknown property.
  const plainFetch = jsonFetch({ status: "pending" });
  await postOpenReceiveJson(plainFetch, "/openreceive/payments/check", {
    order_id: "order-1",
    payment_hash: hash("a"),
    action: "status",
  });
  assert.deepEqual(plainFetch.requests[0].body, {
    order_id: "order-1",
    payment_hash: hash("a"),
  });
});

test("deferred-mode element attributes carry the same create-time options as create mode", () => {
  const options = {
    prefix: "/openreceive",
    metadata: { cart: "abc" },
    syncUrl: true,
    resumePathPrefix: "/pay",
    routeOrderId: "order-1",
    theme: "dark",
  };
  const lock = {
    invoice_id: "lock:order-1",
    rail: "checkout_lock",
    amount_msats: 21_000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
  };
  const created = createCheckoutElementAttributes(null, { ...options, orderId: "order-1" });
  const deferred = createCheckoutElementAttributes(
    {
      checkout_id: "lock:order-1",
      order_id: "order-1",
      status: "open",
      amount_msats: 21_000,
      active: lock,
      invoices: [lock],
    },
    options,
  );

  for (const attribute of ["metadata", "sync-url", "resume-path-prefix", "route-order-id"]) {
    assert.equal(
      deferred[attribute],
      created[attribute],
      `${attribute} must survive prepare-server-side (deferred) mode`,
    );
  }
  assert.equal(deferred.metadata, JSON.stringify({ cart: "abc" }));
  assert.equal(deferred["amount-msats"], "21000");
});

test("swap fee breakdown stays exact on the shared decimal engine", () => {
  assert.deepEqual(
    createOpenReceiveSwapFeeBreakdown({
      currency: "USD",
      pay_in_fiat: "105.5",
      payout_fiat: "100.00",
    }),
    {
      cartTotal: "$100.00",
      youSend: "$105.50",
      fee: "$5.50",
      feePercent: "5.5%",
    },
  );
  // Provider strings are untrusted: junk hides the row instead of throwing.
  assert.equal(
    createOpenReceiveSwapFeeBreakdown({ currency: "USD", pay_in_fiat: "n/a", payout_fiat: "1.00" }),
    undefined,
  );
  assert.equal(
    createOpenReceiveSwapFeeBreakdown({ currency: "USD", pay_in_fiat: "1.00", payout_fiat: "0" }),
    undefined,
  );
});
