import assert from "node:assert/strict";
import test from "node:test";
import {
  createCheckoutController,
  createCheckoutSession,
  createCheckoutState,
  createStatusFetcher,
  createSwapDisplayModel,
} from "../packages/js/browser/src/headless.ts";

const hash = "a".repeat(64);
const attempt = (extra = {}) => ({
  invoice_id: hash,
  payment_hash: hash,
  rail: "lightning",
  invoice: "lnbc-fixture",
  amount_msats: 1000,
  expires_at: 600,
  transaction_state: "pending",
  workflow_state: "invoice_created",
  ...extra,
});
const snapshot = (active) => ({
  checkout_id: hash,
  reference: "order-a",
  status: active.transaction_state === "settled" ? "paid" : "open",
  amount_msats: 1000,
  active,
  invoices: [active],
});
const swap = (provider_state) =>
  attempt({
    rail: "swap",
    invoice: "",
    swap: {
      provider: "fixedfloat",
      pay_in_asset: "USDT_TRON",
      deposit_address: "fixture-address",
      deposit_amount: "1",
      provider_state,
      provider_expires_at: 600,
    },
  });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};

test("instruction expiry preserves independent wallet and refund monitoring", async () => {
  for (const state of [
    "awaiting_deposit",
    "confirming",
    "exchanging",
    "completed",
    "refund_required",
    "refund_pending",
  ]) {
    assert.equal(
      createCheckoutState(snapshot(swap(state)), { now: 2701, logger: false }).terminal,
      false,
      state,
    );
  }
  assert.equal(
    createCheckoutState(snapshot(attempt()), { now: 2701, logger: false }).terminal,
    false,
  );
  const expired = swap("awaiting_deposit");
  const display = createSwapDisplayModel(expired, { now: 600 });
  assert.equal(display.state, "progress");
  assert.match(display.providerStateDetail, /Do not send another payment/);
  const recovery = swap("refund_required");
  recovery.transaction_state = "expired";
  assert.equal(
    createCheckoutState(snapshot(recovery), { now: 2701, logger: false }).terminal,
    false,
  );
  const calls = [];
  const refresh = createStatusFetcher({
    prefix: "/pay",
    snapshot: snapshot(recovery),
    fetch: async (url) => {
      calls.push(url);
      return Response.json({ provider_state: "refund_pending" });
    },
  });
  const next = await refresh("order-a");
  assert.deepEqual(calls, ["/pay/swaps/status"]);
  assert.equal(next.active.swap.provider_state, "refund_pending");
  recovery.swap.provider_state = "refunded";
  assert.equal(
    createCheckoutState(snapshot(recovery), { now: 2701, logger: false }).terminal,
    true,
  );
});

test("deterministic countdown stops instructions at 10m but discovers payout at 26m or after 30m", async () => {
  for (const observedAt of [1600, 1900]) {
    let now = 599,
      paid = false,
      calls = 0;
    const timers = new Map();
    let id = 0;
    const states = [];
    const controller = createCheckoutController({
      snapshot: snapshot(swap("confirming")),
      logger: false,
      now: () => now,
      pollIntervalMs: 2000,
      setInterval: (fn, ms) => {
        timers.set(++id, { fn, ms });
        return id;
      },
      clearInterval: (key) => timers.delete(key),
      onState: (s) => states.push(s),
      refreshStatus: async () => {
        calls++;
        return snapshot(
          paid ? { ...swap("completed"), transaction_state: "settled" } : swap("confirming"),
        );
      },
    });
    controller.start();
    now = 600;
    [...timers.values()].find((t) => t.ms === 1000).fn();
    assert.equal(controller.getState().phase, "expired");
    assert.equal(controller.getState().terminal, false);
    assert.equal(
      [...timers.values()].some((t) => t.ms === 1000),
      false,
    );
    now = 1500;
    [...timers.values()][0].fn();
    await flush();
    assert.equal(controller.getState().settled, false);
    // Testkit server finality represents a payout made at 1560, before wallet expiry 1800.
    paid = true;
    now = observedAt;
    [...timers.values()][0].fn();
    await flush();
    assert.equal(controller.getState().settled, true);
    assert.equal(states.filter((s) => s.settled).length, 1);
    assert.equal(timers.size, 0);
    assert.equal(calls, 2);
  }
});

test("plain Lightning settlement after local expiry and cancellation of in-flight refresh", async () => {
  let now = 599;
  const pending = deferred();
  const states = [];
  const timers = new Map();
  let id = 0;
  const controller = createCheckoutController({
    snapshot: snapshot(attempt()),
    logger: false,
    now: () => now,
    setInterval: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearInterval: (key) => timers.delete(key),
    onState: (s) => states.push(s),
    refreshStatus: () => pending.promise,
  });
  controller.start();
  now = 601;
  [...timers.values()].find((t) => t.ms === 1000).fn();
  const reload = controller.reloadState();
  controller.cancel();
  pending.resolve(snapshot(attempt({ transaction_state: "settled" })));
  await reload;
  assert.equal(controller.getState().phase, "cancelled");
  assert.equal(timers.size, 0);
  assert.equal(
    states.some((s) => s.settled),
    false,
  );
  const live = createCheckoutController({
    snapshot: snapshot(attempt()),
    logger: false,
    now: () => now,
    setInterval: () => 0,
    clearInterval: () => {},
    refreshStatus: async () => snapshot(attempt({ transaction_state: "settled" })),
    onState: () => {},
  });
  live.start();
  await live.reloadState();
  assert.equal(live.getState().settled, true);
  live.stop();
});

test("session generations reject A-B-A, endpoint-only, stale errors and old finally", async () => {
  let reference = "A",
    prefix = "/one",
    current;
  const requests = [],
    errors = [];
  const session = createCheckoutSession({
    snapshot: () => current,
    reference: () => reference,
    prefix: () => prefix,
    onChange: () => {},
    onError: (e) => errors.push(e),
    onSnapshot: (s) => {
      current = s;
    },
    requestCheckout: (_reference, signal) => {
      const d = deferred();
      requests.push({ ...d, signal });
      return d.promise;
    },
  });
  const a = session.ensureLightning();
  reference = "B";
  session.syncIdentity();
  const b = session.ensureLightning();
  assert.equal(requests[0].signal.aborted, true);
  requests[0].reject(new Error("stale error"));
  await a;
  assert.equal(session.mintingLightning, true);
  assert.deepEqual(errors, []);
  reference = "A";
  session.syncIdentity();
  const a2 = session.ensureLightning();
  requests[1].resolve(snapshot(attempt()));
  await b;
  assert.equal(session.mintingLightning, true);
  assert.equal(current, undefined);
  prefix = "/two";
  session.syncIdentity();
  requests[2].resolve(snapshot(attempt()));
  await a2;
  assert.equal(current, undefined);
  const final = session.ensureLightning();
  session.dispose();
  requests[3].resolve(snapshot(attempt()));
  await final;
  assert.equal(current, undefined);
});

test("stale quote never starts an order and stale create never publishes an address", async () => {
  for (const delayed of ["quote", "create"]) {
    let reference = "A";
    const pending = deferred(),
      calls = [],
      published = [];
    const session = createCheckoutSession({
      snapshot: () => undefined,
      reference: () => reference,
      onChange: () => {},
      onError: (e) => {
        throw e;
      },
      swap: {
        prefix: () => "/pay",
        fetch: () => async (url) => {
          calls.push(url);
          if (url.endsWith(delayed === "quote" ? "/quote" : "/swaps")) return pending.promise;
          return Response.json({ quote: { pay_asset: "USDT_TRON", available: true } });
        },
        selection: {
          started: () => undefined,
          setStarted: (i) => published.push(i),
          dismissedInvoiceId: () => null,
          setDismissedInvoiceId: () => {},
          setSelectedAsset: () => {},
        },
        onStarted: (i) => published.push(i),
      },
    });
    const action = session.startSwap("USDT_TRON");
    await flush();
    reference = "B";
    session.syncIdentity();
    pending.resolve(
      Response.json(
        delayed === "quote"
          ? { quote: { pay_asset: "USDT_TRON", available: true } }
          : { swap: { ...swap("awaiting_deposit").swap, payment_hash: hash } },
      ),
    );
    await action;
    assert.deepEqual(published, []);
    assert.deepEqual(session.swapQuotes, {});
    if (delayed === "quote") assert.equal(calls.length, 1);
  }
});

test("dismissed swap actions cannot reopen the panel", async () => {
  for (const delayed of ["quote", "create"]) {
    let reference = "A";
    const pending = deferred(),
      calls = [],
      published = [];
    const session = createCheckoutSession({
      snapshot: () => undefined,
      reference: () => reference,
      onChange: () => {},
      onError: (e) => {
        throw e;
      },
      swap: {
        prefix: () => "/pay",
        fetch: () => async (url) => {
          calls.push(url);
          if (url.endsWith(delayed === "quote" ? "/quote" : "/swaps")) return pending.promise;
          return Response.json({ quote: { pay_asset: "USDT_TRON", available: true } });
        },
        selection: {
          started: () => undefined,
          setStarted: (i) => published.push(i),
          dismissedInvoiceId: () => null,
          setDismissedInvoiceId: () => {},
          setSelectedAsset: () => {},
        },
        onStarted: (i) => published.push(i),
      },
    });
    const action = session.startSwap("USDT_TRON");
    await flush();
    session.clearSwapStartError();
    pending.resolve(
      Response.json(
        delayed === "quote"
          ? { quote: { pay_asset: "USDT_TRON", available: true } }
          : { swap: { ...swap("awaiting_deposit").swap, payment_hash: hash } },
      ),
    );
    await action;
    assert.deepEqual(published, []);
    assert.equal(session.startingSwapAsset, null);
    if (delayed === "quote") assert.equal(calls.length, 1);
  }
});
