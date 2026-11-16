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

test("provider completion never reports wallet settlement and wallet failure retains refund recovery", async () => {
  const states = [];
  let active = swap("completed");
  const controller = createCheckoutController({
    snapshot: snapshot(active),
    now: () => 2701,
    logger: false,
    refreshStatus: async () => snapshot(active),
    onState: (state) => states.push(state),
    setInterval: () => 0,
    clearInterval: () => {},
  });
  controller.start();
  await controller.reloadState();
  assert.equal(controller.getState().settled, false);
  assert.equal(controller.getState().terminal, false);
  active = { ...swap("refund_required"), transaction_state: "failed" };
  await controller.reloadState();
  assert.equal(controller.getState().terminal, false);
  active.swap.provider_state = "refunded";
  await controller.reloadState();
  assert.equal(controller.getState().terminal, true);
  assert.equal(
    states.some((state) => state.settled),
    false,
  );
  controller.stop();
});

test("staged and confirmed refund replies cannot update a replaced controller", async () => {
  for (const action of ["stageSwapRefund", "confirmSwapRefund"]) {
    const pending = deferred();
    const states = [];
    const controller = createCheckoutController({
      snapshot: snapshot(swap("refund_required")),
      prefix: "/pay",
      polling: false,
      logger: false,
      fetch: () => pending.promise,
      onState: (state) => states.push(state),
    });
    controller.start();
    const request = controller[action]({ attemptId: hash, refundAddress: "fixture-address" });
    controller.stop();
    const previous = states.length;
    pending.resolve(Response.json({ ...swap("refund_pending").swap, payment_hash: hash }));
    await assert.rejects(request, { name: "AbortError" });
    assert.equal(states.length, previous);
    assert.equal(controller.getState().swap.provider_state, "refund_required");
  }
});

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

// The picker's quote (`quoteSwap`) is an action like the other two: it belongs
// to the order it was asked for. One that lands after the order changed, or
// after the payer left the coin, must not put an amount on the next screen.
test("a picker quote belongs to the order and the visit it was asked for", async () => {
  for (const left of ["identity", "dismissal"]) {
    let reference = "A";
    const requests = [];
    let changes = 0;
    const session = createCheckoutSession({
      snapshot: () => undefined,
      reference: () => reference,
      onChange: () => {
        changes += 1;
      },
      onError: (e) => {
        throw e;
      },
      swap: {
        prefix: () => "/pay",
        fetch: () => async (url, init) => {
          const pending = deferred();
          requests.push({ url, body: JSON.parse(init.body), signal: init.signal, pending });
          return pending.promise;
        },
        selection: {
          started: () => undefined,
          setStarted: () => {},
          dismissedInvoiceId: () => null,
          setDismissedInvoiceId: () => {},
          setSelectedAsset: () => {},
        },
      },
    });
    const answer = (request, pay_amount) =>
      request.pending.resolve(
        Response.json({
          quote: { pay_asset: request.body.pay_in_asset, available: true, pay_amount },
        }),
      );

    const stale = session.quoteSwap("USDT_TRON");
    await flush();
    assert.equal(session.quotingSwapAsset, "USDT_TRON");
    assert.equal(requests.length, 1);
    if (left === "identity") {
      reference = "B";
      session.syncIdentity();
    } else {
      session.clearSwapStartError();
    }
    assert.equal(session.quotingSwapAsset, null, "nothing is being quoted for the new screen");
    assert.equal(requests[0].signal.aborted, true, "the request it can abort is aborted");

    // The same coin, asked again: a request of its own, not the dead one's.
    const fresh = session.quoteSwap("USDT_TRON");
    await flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.reference, reference);
    assert.equal(session.quotingSwapAsset, "USDT_TRON");

    // The dead quote lands first. It is not stored, and it does not end the
    // live one's spinner.
    answer(requests[0], "1.11");
    await stale;
    assert.deepEqual(session.swapQuotes, {});
    assert.equal(session.quotingSwapAsset, "USDT_TRON");

    const before = changes;
    answer(requests[1], "2.22");
    await fresh;
    assert.equal(session.swapQuotes.USDT_TRON.pay_amount, "2.22");
    assert.equal(session.quotingSwapAsset, null);
    assert.equal(changes, before + 1, "one re-render for the amount that arrived");
  }
});

// Two coins looked at in quick succession: both quotes are kept, and the
// spinner follows the coin the payer is on now.
test("the quoting flag follows the asset asked for last", async () => {
  const requests = new Map();
  const session = createCheckoutSession({
    snapshot: () => undefined,
    reference: () => "A",
    onChange: () => {},
    onError: (e) => {
      throw e;
    },
    swap: {
      prefix: () => "/pay",
      fetch: () => async (_url, init) => {
        const pending = deferred();
        requests.set(JSON.parse(init.body).pay_in_asset, pending);
        return pending.promise;
      },
      selection: {
        started: () => undefined,
        setStarted: () => {},
        dismissedInvoiceId: () => null,
        setDismissedInvoiceId: () => {},
        setSelectedAsset: () => {},
      },
    },
  });
  const quote = (pay_asset, pay_amount) =>
    Response.json({ quote: { pay_asset, available: true, pay_amount } });

  const sol = session.quoteSwap("SOL_SOL");
  const eth = session.quoteSwap("ETH_ETH");
  await flush();
  assert.equal(session.quotingSwapAsset, "ETH_ETH");
  // Back to SOL while its first request is still open: no second request.
  const solAgain = session.quoteSwap("SOL_SOL");
  await flush();
  assert.equal(requests.size, 2);
  assert.equal(session.quotingSwapAsset, "SOL_SOL");

  requests.get("ETH_ETH").resolve(quote("ETH_ETH", "0.0031"));
  await eth;
  assert.equal(session.quotingSwapAsset, "SOL_SOL", "ETH landing does not stop SOL's spinner");
  requests.get("SOL_SOL").resolve(quote("SOL_SOL", "0.0421"));
  await Promise.all([sol, solAgain]);
  assert.equal(session.quotingSwapAsset, null);
  assert.deepEqual(
    Object.fromEntries(Object.entries(session.swapQuotes).map(([k, v]) => [k, v.pay_amount])),
    { ETH_ETH: "0.0031", SOL_SOL: "0.0421" },
  );
});
