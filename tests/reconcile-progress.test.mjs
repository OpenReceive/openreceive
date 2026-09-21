import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPaymentScanWindow, scanPaymentSlice } from "../packages/js/core/src/payment-scan.ts";
import {
  createHost,
  createSqlPayments,
  maybeReconcilePayments,
} from "../packages/js/http/src/index.ts";
import { memoryPaymentsDb } from "./helpers/factories.mjs";
const spec = JSON.parse(readFileSync("spec/test-vectors/reconcile-progress.json", "utf8"));
const hash = (n) => n.toString(16).padStart(64, "0");
const snapshot = (n, createdAt = 1000, createdAtSource = "wallet") => ({
  reference: `order-${n}`,
  paymentHash: hash(n),
  checkout: {
    reference: `order-${n}`,
    paymentHash: hash(n),
    bolt11: `lnbc-test-${n}`,
    amountMsats: 1000,
    createdAt,
    createdAtSource,
    expiresAt: 1600,
    fiatQuote: null,
  },
});
const silent = () => {};

function wallet(rows, cap = 20) {
  const calls = [];
  return {
    calls,
    async listTransactions(request) {
      calls.push(request);
      assert.equal(request.limit, 20);
      const filtered = rows.filter(
        (row) =>
          (request.from === undefined || row.created_at >= request.from) &&
          (request.until === undefined || row.created_at <= request.until),
      );
      return {
        transactions: filtered.slice(request.offset, request.offset + Math.min(cap, request.limit)),
      };
    },
  };
}
function service(client, clock) {
  return { scanPaymentSlice: (input) => scanPaymentSlice({ ...input, client, clock }) };
}

test(spec.vectors[0].name, async () => {
  const scenario = spec.vectors[0];
  const db = memoryPaymentsDb();
  let now = 1100;
  const clock = () => now;
  const repository = createSqlPayments(db, { clock });
  for (let n = 0; n < scenario.pending_count; n++) await repository.commitAttempt(snapshot(n));
  const client = wallet([
    { payment_hash: hash(scenario.paid_index), created_at: 1000, settled_at: 1050 },
  ]);
  const fulfilled = [];
  for (let pass = 0; pass < scenario.max_passes; pass++) {
    // Reconstruct repositories on every slice to prove process-local state is unnecessary.
    const host = createHost({
      db,
      clock,
      amountFor: () => ({ sats: 1 }),
      onPaid: (event) => fulfilled.push(event.reference),
    });
    const before = client.calls.length;
    await maybeReconcilePayments({ host, service: service(client, clock), clock, onError: silent });
    assert.ok(client.calls.length - before <= spec.max_pages);
    now += 12;
  }
  assert.deepEqual(fulfilled, [`order-${scenario.paid_index}`]);
});

for (const scenario of spec.vectors.slice(1, 3))
  test(scenario.name, async () => {
    const rows = Array.from({ length: scenario.history_rows }, (_, n) => ({
      payment_hash: hash(n),
      created_at: 1000,
      settled_at: 1050,
    }));
    const client = wallet(rows, scenario.page_size);
    const db = memoryPaymentsDb();
    let now = 2000;
    const clock = () => now;
    await createSqlPayments(db, { clock }).commitAttempt(snapshot(scenario.paid_index));
    let delivered = 0;
    for (let pass = 0; pass < scenario.max_passes; pass++) {
      const host = createHost({
        db,
        clock,
        amountFor: () => ({ sats: 1 }),
        onPaid: () => {
          delivered++;
        },
      });
      const before = client.calls.length;
      await maybeReconcilePayments({
        host,
        service: service(client, clock),
        clock,
        onError: silent,
      });
      assert.ok(client.calls.length - before <= spec.max_pages);
      const progress = db
        .prepare("SELECT value FROM openreceive_meta WHERE key = 'transaction_scan_gate'")
        .get().value;
      assert.ok(Buffer.byteLength(progress) <= spec.max_checkpoint_bytes);
      assert.ok(!progress.includes("settled_at"), "wallet payload is not persisted in progress");
      now += 12;
    }
    assert.equal(delivered, 1);
  });

test(spec.vectors[3].name, async () => {
  const scenario = spec.vectors[3];
  const rows = Array.from({ length: scenario.history_rows }, (_, n) => ({
    payment_hash: hash(n + 1),
    created_at: 1000,
  }));
  const client = wallet(rows);
  let window = createPaymentScanWindow(
    [{ payment_hash: hash(0), created_at: 1000, expires_at: 1600, created_at_source: "wallet" }],
    3000,
  );
  const checks = [];
  for (let pass = 0; pass < 4; pass++) {
    const result = await scanPaymentSlice({
      client,
      window: JSON.parse(JSON.stringify(window)),
      clock: () => 3000,
    });
    checks.push(...result.checks);
    window = result.window;
    if (result.outcome === "complete") break;
  }
  assert.deepEqual(checks, [], "resumed offsets never prove absence or expire the row");
});

test(spec.vectors[4].name, async () => {
  const db = memoryPaymentsDb();
  const a = createSqlPayments(db);
  const b = createSqlPayments(db);
  const old = await a.claimReconcileGate({ now: 1000, intervalSeconds: 2, leaseSeconds: 10 });
  assert.equal(await b.claimReconcileGate({ now: 1009, intervalSeconds: 2 }), null);
  const current = await b.claimReconcileGate({ now: 1011, intervalSeconds: 2 });
  assert.ok(current.token);
  assert.equal(
    await a.checkpointReconcileGate({
      claim: old,
      scheduler: { cursor: { created_at: 1, payment_hash: hash(0) }, windows: [] },
      now: 1011,
    }),
    false,
  );
  assert.equal(
    await b.checkpointReconcileGate({
      claim: current,
      scheduler: current.scheduler,
      now: 1011,
      release: true,
    }),
    true,
  );
});

test("legacy host-clock timestamps cannot hide a paid invoice beyond the overlap", async () => {
  const db = memoryPaymentsDb();
  const clock = () => 5000;
  const repository = createSqlPayments(db, { clock });
  await repository.commitAttempt(snapshot(1, 4000, undefined));
  db.prepare(
    "UPDATE openreceive_payments SET checkout_data = json_remove(checkout_data, '$.createdAtSource')",
  ).run();
  const client = wallet([{ payment_hash: hash(1), created_at: 1000, settled_at: 2000 }]);
  let delivered = 0;
  const host = createHost({
    db,
    clock,
    amountFor: () => ({ sats: 1 }),
    onPaid: () => {
      delivered++;
    },
  });
  await maybeReconcilePayments({ host, service: service(client, clock), clock, onError: silent });
  assert.equal(delivered, 1);
  assert.equal(client.calls[0].from, 0);
  assert.equal(client.calls[0].until, undefined);
});

test("positive finality commits before a later failed page, while unknown attempts stay pending", async () => {
  const db = memoryPaymentsDb();
  const clock = () => 3000;
  const host = createHost({ db, clock, amountFor: () => ({ sats: 1 }), onPaid: () => {} });
  await host.payments.commitAttempt(snapshot(1));
  await host.payments.commitAttempt(snapshot(2));
  let calls = 0;
  const client = {
    listTransactions: async () => {
      if (++calls === 1)
        return { transactions: [{ payment_hash: hash(1), created_at: 1000, settled_at: 1200 }] };
      throw new Error("later page unavailable");
    },
  };
  const result = await maybeReconcilePayments({
    host,
    service: service(client, clock),
    clock,
    onError: silent,
  });
  assert.equal(result.reason, "scan_failed");
  assert.equal((await host.payments.findByPaymentHash(hash(1))).status, "settled");
  assert.equal((await host.payments.findByPaymentHash(hash(2))).status, "pending");
  db.close();
});

test(spec.vectors[5].name, async () => {
  const scenario = spec.vectors[5];
  const db = memoryPaymentsDb();
  let now = 100_000;
  const clock = () => now;
  const repository = createSqlPayments(db, { clock });
  for (let n = 0; n < scenario.pending_count; n++)
    await repository.commitAttempt(snapshot(n, 1000 + n * scenario.creation_stride));
  const paidAt = 1000 + scenario.paid_index * scenario.creation_stride;
  let calls = 0;
  const client = {
    async listTransactions(request) {
      calls++;
      if (request.from < paidAt - 60) throw new Error("historical cohort unavailable");
      return {
        transactions: [
          { payment_hash: hash(scenario.paid_index), created_at: paidAt, settled_at: paidAt + 1 },
        ],
      };
    },
  };
  const paid = [];
  for (let pass = 0; pass < scenario.max_passes; pass++) {
    const host = createHost({
      db,
      clock,
      amountFor: () => ({ sats: 1 }),
      onPaid: (event) => paid.push(event.reference),
    });
    await maybeReconcilePayments({ host, service: service(client, clock), clock, onError: silent });
    now += 12;
  }
  assert.deepEqual(paid, [`order-${scenario.paid_index}`]);
  assert.equal(calls, scenario.max_passes);
  assert.equal((await repository.findByPaymentHash(hash(0))).status, "pending");
  db.close();
});

test(spec.vectors[7].name, async () => {
  const scenario = spec.vectors[7];
  const db = memoryPaymentsDb();
  let now = 2000,
    failures = scenario.failed_fulfillments;
  const clock = () => now;
  const repo = createSqlPayments(db, { clock });
  await repo.commitAttempt(snapshot(0));
  const client = wallet([{ payment_hash: hash(0), created_at: 1000, settled_at: 1001 }]);
  const paid = [];
  for (let pass = 0; pass < scenario.max_passes; pass++) {
    for (let n = 0; n < scenario.arrivals_per_pass; n++)
      await repo.commitAttempt(snapshot(1000 + pass * scenario.arrivals_per_pass + n, now));
    const host = createHost({
      db,
      clock,
      amountFor: () => ({ sats: 1 }),
      onPaid: (event) => {
        if (failures-- > 0) throw new Error("host rollback");
        paid.push(event.paymentHash);
      },
    });
    await maybeReconcilePayments({ host, service: service(client, clock), clock, onError: silent });
    now += 12;
  }
  assert.deepEqual(paid, [hash(0)]);
  assert.equal((await repo.findByPaymentHash(hash(0))).status, "settled");
  db.close();
});

test(spec.vectors[6].name, async () => {
  const scenario = spec.vectors[6];
  const db = memoryPaymentsDb();
  let now = scenario.coverage_started_at;
  const clock = () => now;
  const host = createHost({
    db,
    clock,
    amountFor: () => ({ sats: 1 }),
    onPaid: () => assert.fail("no payment"),
  });
  await host.payments.commitAttempt(snapshot(1, scenario.created_at));
  const client = {
    async listTransactions() {
      now = Math.max(now, scenario.completed_at);
      return { transactions: [] };
    },
  };
  const result = await maybeReconcilePayments({ host, service: service(client, clock), clock });
  assert.equal(result.checks[0].coverageStartedAt, scenario.coverage_started_at);
  assert.equal((await host.payments.findByPaymentHash(hash(1))).status, "pending");
  now = scenario.next_scan_at;
  await maybeReconcilePayments({ host, service: service(client, clock), clock });
  assert.equal((await host.payments.findByPaymentHash(hash(1))).status, "expired");
  db.close();
});
