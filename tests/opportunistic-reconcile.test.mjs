import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createOpenReceive } from "../packages/js/node/src/index.ts";
import {
  createOpenReceiveHost,
  createOpenReceiveHttpHandler,
  maybeReconcileOpenReceivePayments,
  openReceivePaymentsSchemaSql,
  openReceiveReconcileIntervalSeconds,
  startOpenReceiveReconciler,
} from "../packages/js/http/src/index.ts";
import { createTestkitReceiveClient } from "../packages/js/testkit/src/index.ts";

// End-to-end fixture over the REAL SQL repository (including the
// openreceive_meta gate) and a wallet whose list_transactions calls we count:
// the durable gate is the NWC budget, so every test here is really about how
// many wallet walks a burst of traffic is allowed to cost.
async function fixture() {
  const state = { now: 1_000 };
  const clock = () => state.now;
  const wallet = createTestkitReceiveClient({ now: clock });
  const walks = [];
  const listTransactions = wallet.listTransactions.bind(wallet);
  wallet.listTransactions = async (request) => {
    walks.push(request);
    return listTransactions(request);
  };
  const service = await createOpenReceive({ client: wallet, clock });
  const db = new DatabaseSync(":memory:");
  db.exec(openReceivePaymentsSchemaSql("sqlite"));
  const orders = new Map();
  const paid = [];
  const host = createOpenReceiveHost({
    db,
    clock,
    loadOrder: (orderId) => orders.get(orderId) ?? null,
    amountForOrder: (order) => order.amount,
    onPaid: async (settlement) => {
      paid.push(settlement);
    },
  });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host,
    clock,
  });
  return { state, wallet, service, db, orders, paid, host, handler, walks };
}

function postJson(path, body) {
  return new Request(`http://test/openreceive${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createCheckout(fix, orderId) {
  fix.orders.set(orderId, { amount: { sats: 21 } });
  const response = await fix.handler(postJson("/checkouts", { order_id: orderId }));
  assert.equal(response.status, 201);
  return (await response.json()).checkout;
}

test("user A's abandoned checkout settles when user B's later call wins the gate", async () => {
  const fix = await fixture();
  const checkout = await createCheckout(fix, "order-a");
  // User A closes the tab; the wallet settles the invoice afterwards.
  fix.wallet.settleInvoice({ payment_hash: checkout.payment_hash }, { settled_at: 1_005 });
  fix.state.now = 1_010;

  // User B's unrelated checkout create runs the gated pass before its own work.
  await createCheckout(fix, "order-b");

  assert.equal(fix.paid.length, 1);
  assert.equal(fix.paid[0].orderId, "order-a");
  const row = fix.db
    .prepare("SELECT status, paid_at FROM openreceive_payments WHERE order_id = ?")
    .get("order-a");
  assert.equal(row.status, "settled");
  assert.equal(row.paid_at, 1_005);
});

test("an empty pending set makes no wallet call", async () => {
  const fix = await fixture();
  await createCheckout(fix, "order-empty");
  // The create minted an invoice (make_invoice) but the pass before it had
  // nothing pending: zero list_transactions walks.
  assert.equal(fix.walks.length, 0);
});

test("a second request inside the interval is gate_busy and costs no wallet walk", async () => {
  const fix = await fixture();
  const checkout = await createCheckout(fix, "order-a");
  fix.state.now = 1_010;

  const first = await fix.handler(
    postJson("/payments/check", { order_id: "order-a", payment_hash: checkout.payment_hash }),
  );
  assert.equal(first.status, 200);
  const walksAfterFirst = fix.walks.length;
  assert.ok(walksAfterFirst >= 1 && walksAfterFirst <= 2, "the winner scans at most two walks");

  // Same instant (well inside the 2s interval): the loser serves the row.
  const second = await fix.handler(
    postJson("/payments/check", { order_id: "order-a", payment_hash: checkout.payment_hash }),
  );
  assert.equal(second.status, 200);
  assert.equal(fix.walks.length, walksAfterFirst, "gate_busy must not touch the wallet");
  const body = await second.json();
  assert.equal(body.status, "pending");
  assert.equal(body.details, undefined);
});

test("a throwing scan still returns user B's 200", async () => {
  const fix = await fixture();
  await createCheckout(fix, "order-a");
  fix.state.now = 1_010;
  fix.wallet.listTransactions = async () => {
    throw new Error("relay down");
  };

  fix.orders.set("order-b", { amount: { sats: 21 } });
  const response = await fix.handler(postJson("/checkouts", { order_id: "order-b" }));
  assert.equal(response.status, 201);
});

test("two workers sharing one openreceive_meta run one scan per interval", async () => {
  const fix = await fixture();
  await createCheckout(fix, "order-a");
  fix.state.now = 1_010;

  // A second logical worker: its own repository over the SAME host database.
  const workerHost = createOpenReceiveHost({
    db: fix.db,
    clock: () => fix.state.now,
    loadOrder: (orderId) => fix.orders.get(orderId) ?? null,
    amountForOrder: (order) => order.amount,
    onPaid: async () => undefined,
  });

  const first = await maybeReconcileOpenReceivePayments({
    service: fix.service,
    host: workerHost,
    clock: () => fix.state.now,
  });
  assert.equal(first.reason, "ran");
  const second = await maybeReconcileOpenReceivePayments({
    service: fix.service,
    host: fix.host,
    clock: () => fix.state.now,
  });
  assert.equal(second.reason, "gate_busy");

  // After the interval (all pending invoices young: 2s), the gate reopens.
  fix.state.now = 1_013;
  const third = await maybeReconcileOpenReceivePayments({
    service: fix.service,
    host: fix.host,
    clock: () => fix.state.now,
  });
  assert.equal(third.reason, "ran");
});

test("a worker pass inside the gate interval never touches the wallet", async () => {
  const fix = await fixture();
  await createCheckout(fix, "order-a");
  fix.state.now = 1_010;

  // The web request path wins the gate first.
  const first = await maybeReconcileOpenReceivePayments({
    service: fix.service,
    host: fix.host,
    clock: () => fix.state.now,
  });
  assert.equal(first.reason, "ran");
  const walksAfterWeb = fix.walks.length;

  // The polling worker starts inside the interval: its passes are gate_busy.
  const reconciler = await startOpenReceiveReconciler({
    service: fix.service,
    host: fix.host,
    pollIntervalMs: 250,
    clock: () => fix.state.now,
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(fix.walks.length, walksAfterWeb, "worker + web must not double-scan");

  // Once the interval elapses, the worker wins the gate and scans.
  fix.state.now = 1_013;
  const startedAt = Date.now();
  while (fix.walks.length === walksAfterWeb) {
    if (Date.now() - startedAt > 2_000) assert.fail("worker never scanned after the interval");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  reconciler.stop();
  await reconciler.done;
});

test("GET /rates never claims the reconcile gate or scans the wallet", async () => {
  const fix = await fixture();
  await createCheckout(fix, "order-a");
  fix.state.now = 1_010;
  let claims = 0;
  const claim = fix.host.payments.claimReconcileGate.bind(fix.host.payments);
  fix.host.payments.claimReconcileGate = (input) => {
    claims += 1;
    return claim(input);
  };
  const walksBefore = fix.walks.length;
  const handler = createOpenReceiveHttpHandler({
    service: { ...fix.service, listRates: async () => ({ rates: [] }) },
    authorize: () => true,
    host: fix.host,
    clock: () => fix.state.now,
  });

  const response = await handler(new Request("http://test/openreceive/rates"));
  assert.equal(response.status, 200);
  assert.equal(claims, 0, "an unauthenticated rates fetch must not consume the scan budget");
  assert.equal(fix.walks.length, walksBefore);

  // A payment route on the same handler still triggers the gated pass.
  const checked = await fix.handler(postJson("/checkouts/prepare", { order_id: "order-a" }));
  assert.equal(checked.status, 200);
  assert.equal(claims, 1);
});

test("payments/check with three pending orders costs one gate claim and at most two walks", async () => {
  const fix = await fixture();
  const checkout = await createCheckout(fix, "order-1");
  await createCheckout(fix, "order-2");
  await createCheckout(fix, "order-3");
  fix.wallet.settleInvoice({ payment_hash: checkout.payment_hash }, { settled_at: 1_005 });
  fix.state.now = 1_010;

  let claims = 0;
  const claim = fix.host.payments.claimReconcileGate.bind(fix.host.payments);
  fix.host.payments.claimReconcileGate = (input) => {
    claims += 1;
    return claim(input);
  };
  const walksBefore = fix.walks.length;

  const response = await fix.handler(
    postJson("/payments/check", { order_id: "order-1", payment_hash: checkout.payment_hash }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "settled");
  assert.equal(body.paid_at, 1_005);
  assert.notEqual(body.details, undefined, "the gate winner serves details from the pass");

  assert.equal(claims, 1, "exactly one gate claim per request");
  const walkCount = fix.walks.length - walksBefore;
  assert.ok(walkCount <= 2, `three pending orders share one window: ${walkCount} walks`);
  // One shared time window: from = oldest created_at (1000) minus the 60s overlap.
  for (const request of fix.walks.slice(walksBefore)) {
    assert.equal(request.from, 940);
  }
});

test("payments/check under gate_busy serves the row; attention reads as pending on the wire", async () => {
  const fix = await fixture();
  const settled = await createCheckout(fix, "order-settled");
  const stuck = await createCheckout(fix, "order-stuck");
  fix.db
    .prepare(
      "UPDATE openreceive_payments SET status = 'settled', paid_at = ? WHERE payment_hash = ?",
    )
    .run(1_005, settled.payment_hash);
  fix.db
    .prepare("UPDATE openreceive_payments SET status = 'attention' WHERE payment_hash = ?")
    .run(stuck.payment_hash);
  // order-stuck stays reconcilable? No: attention is terminal — make one more
  // pending order so the pass has work, then hold the gate so requests lose it.
  await createCheckout(fix, "order-pending");
  fix.state.now = 1_010;
  assert.equal(
    await fix.host.payments.claimReconcileGate({ now: 1_010, intervalSeconds: 2 }),
    true,
  );

  const settledResponse = await fix.handler(
    postJson("/payments/check", { order_id: "order-settled", payment_hash: settled.payment_hash }),
  );
  assert.equal(settledResponse.status, 200);
  const settledBody = await settledResponse.json();
  assert.equal(settledBody.status, "settled");
  assert.equal(settledBody.paid_at, 1_005);
  assert.equal(settledBody.details, undefined, "the row path omits details");

  const stuckResponse = await fix.handler(
    postJson("/payments/check", { order_id: "order-stuck", payment_hash: stuck.payment_hash }),
  );
  assert.equal(stuckResponse.status, 200);
  const stuckBody = await stuckResponse.json();
  assert.equal(stuckBody.status, "pending", "attention is operator state, not payer information");
  assert.equal(stuckBody.paid_at, undefined);
  assert.equal(stuckBody.details, undefined);
});

test("a pass exceeding the scan timeout is a failed scan and the gate stays claimed", async () => {
  const fix = await fixture();
  await createCheckout(fix, "order-a");
  fix.state.now = 1_010;
  fix.wallet.listTransactions = () => new Promise(() => undefined);

  const warnings = [];
  const result = await maybeReconcileOpenReceivePayments({
    service: fix.service,
    host: fix.host,
    clock: () => fix.state.now,
    scanTimeoutMs: 50,
    onError: (error) => warnings.push(error),
  });
  assert.equal(result.reason, "scan_failed");
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]), /exceeded 50ms/);
  // claimed_at stays: no stampede while the wallet is broken.
  assert.equal(
    await fix.host.payments.claimReconcileGate({ now: fix.state.now, intervalSeconds: 2 }),
    false,
  );
});

test("the default failure sink redacts secrets instead of printing raw error text", async () => {
  const fix = await fixture();
  await createCheckout(fix, "order-a");
  fix.state.now = 1_010;
  const leaked = "nostr+walletconnect://abc?relay=wss://relay.test&secret=deadbeefcafe";
  fix.wallet.listTransactions = async () => {
    throw new Error(`relay rejected ${leaked}`);
  };

  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    // No onError: this is the DEFAULT sink, the one a host never configures.
    const result = await maybeReconcileOpenReceivePayments({
      service: fix.service,
      host: fix.host,
      clock: () => fix.state.now,
    });
    assert.equal(result.reason, "scan_failed");
  } finally {
    console.warn = original;
  }

  const line = warnings.join("\n");
  assert.match(line, /opportunistic reconcile failed/);
  assert.doesNotMatch(line, /nostr\+walletconnect/);
  assert.doesNotMatch(line, /deadbeefcafe/);
  assert.match(line, /\[REDACTED_NWC\]/);
});

test("a custom repository without claimReconcileGate fails construction unless disabled", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1_000 }),
    clock: () => 1_000,
  });
  const gateLessHost = {
    resolveCheckout: () => ({ amount: { sats: 1 } }),
    onCheckoutCreated: () => undefined,
    onPaid: async () => undefined,
    payments: {
      listForOrder: async () => [],
      commitAttempt: () => undefined,
      listReconcilableAttempts: async () => [],
      recordReconciliation: async () => undefined,
    },
  };
  assert.throws(
    () => createOpenReceiveHttpHandler({ service, authorize: () => true, host: gateLessHost }),
    /claimReconcileGate/,
  );
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: gateLessHost,
    opportunisticReconcile: false,
  });
  assert.equal(typeof handler, "function");
});

test("the gate interval stretches with pending-invoice age", () => {
  const attempt = (createdAt) => ({ paymentHash: "ab".repeat(32), createdAt, expiresAt: 99_999 });
  assert.equal(openReceiveReconcileIntervalSeconds([attempt(990)], 1_000), 2);
  assert.equal(openReceiveReconcileIntervalSeconds([attempt(750)], 1_000), 6);
  assert.equal(openReceiveReconcileIntervalSeconds([attempt(100)], 1_000), 12);
  // The youngest pending invoice drives the pace.
  assert.equal(openReceiveReconcileIntervalSeconds([attempt(100), attempt(990)], 1_000), 2);
  // A configured floor can only slow it down, never beat the 2s minimum.
  assert.equal(openReceiveReconcileIntervalSeconds([attempt(990)], 1_000, 5), 5);
  assert.equal(openReceiveReconcileIntervalSeconds([attempt(990)], 1_000, 1), 2);
});
