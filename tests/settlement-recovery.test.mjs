import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createHost,
  createSqlPayments,
  paymentsSchemaSql,
  maybeReconcilePayments,
} from "../packages/js/http/src/index.ts";
import { scanPaymentSlice } from "../packages/js/core/src/payment-scan.ts";
import { memoryPaymentsDb } from "./helpers/factories.mjs";
const hash = "a".repeat(64);
const input = {
  reference: "order",
  paymentHash: hash,
  checkout: {
    reference: "order",
    paymentHash: hash,
    bolt11: "lnbc-test",
    amountMsats: 1000,
    createdAt: 1000,
    expiresAt: 2800,
    fiatQuote: null,
  },
};
const swapData = {
  version: 1,
  providerOrder: {
    provider: "test",
    provider_order_id: "test",
    provider_token: "test-private",
    pay_in_asset: "USDT_TRON",
    expires_at: 1600,
  },
};

for (const scenario of JSON.parse(
  readFileSync("spec/test-vectors/attempt-reconciliation.json", "utf8"),
).snapshot_cases) {
  test(`saved snapshot: ${scenario.name}`, async () => {
    const db = memoryPaymentsDb();
    const clock = () => scenario.observed_at;
    const host = createHost({
      db,
      clock,
      amountFor: () => ({ sats: 1 }),
      onPaid: () => assert.fail("no payment"),
    });
    await host.payments.commitAttempt({ ...input, swapData });
    await maybeReconcilePayments({
      host,
      clock,
      service: {
        scanPaymentSlice: (args) =>
          scanPaymentSlice({
            ...args,
            clock,
            client: { listTransactions: async () => ({ transactions: [] }) },
          }),
      },
    });
    assert.equal(
      (await host.payments.listForReference("order"))[0].status,
      scenario.expected?.status ?? "pending",
    );
  });
}

test("legacy snake_case checkout deadlines remain reconcilable without extending deposit reuse", async () => {
  const db = memoryPaymentsDb();
  const clock = () => 2500;
  const host = createHost({
    db,
    clock,
    amountFor: () => ({ sats: 1 }),
    onPaid: () => assert.fail("no payment"),
  });
  await host.payments.commitAttempt({ ...input, swapData });
  const checkout = { ...input.checkout, expires_at: 2800, created_at_source: "wallet" };
  delete checkout.expiresAt;
  db.prepare("UPDATE openreceive_payments SET checkout_data = ?").run(JSON.stringify(checkout));
  assert.equal((await host.payments.findPendingAttempt(hash)).expiresAt, 2800);
  assert.equal((await host.payments.findPendingAttempt(hash)).createdAtSource, "wallet");
  await maybeReconcilePayments({
    host,
    clock,
    service: {
      scanPaymentSlice: (args) =>
        scanPaymentSlice({
          ...args,
          clock,
          client: { listTransactions: async () => ({ transactions: [] }) },
        }),
    },
  });
  const row = await host.payments.findByPaymentHash(hash);
  assert.equal(row.status, "pending");
  assert.equal(row.expiresAt, 1600);
  db.prepare("UPDATE openreceive_payments SET checkout_data = ?").run(
    JSON.stringify({ expires_at: "bad", provider_token: "test-private" }),
  );
  await assert.rejects(host.payments.findPendingAttempt(hash), (error) => {
    assert.match(error.message, new RegExp(`checkout_data.*${hash}`));
    assert.ok(!error.message.includes("test-private"));
    return true;
  });
  db.close();
});

test("dry-run recovery distinguishes early closures and attention, audits only reviewed requeue", async () => {
  const db = memoryPaymentsDb();
  const repository = createSqlPayments(db, { clock: () => 5000 });
  await repository.commitAttempt({ ...input, swapData });
  db.prepare(
    "UPDATE openreceive_payments SET status = 'expired', status_reason = 'not_found_after_expiry', updated_at = 2500",
  ).run();
  const report = await repository.listRepairCandidates();
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].category, "early_swap_closure");
  assert.ok(!JSON.stringify(report).includes("test-private"));
  assert.equal((await repository.listForReference("order"))[0].status, "expired");
  const selected = {
    paymentHash: hash,
    expectedStatus: "expired",
    expectedUpdatedAt: 2500,
    reason: "Reviewed wallet deadline",
  };
  assert.equal(await repository.requeueAttempt({ ...selected, expectedUpdatedAt: 2499 }), false);
  assert.equal(await repository.requeueAttempt(selected), true);
  assert.equal(await repository.requeueAttempt(selected), false);
  db.prepare(
    "UPDATE openreceive_payments SET status='expired', status_reason='not_found_after_expiry', updated_at=2500",
  ).run();
  assert.equal(
    await repository.requeueAttempt(selected),
    false,
    "the selected decision remains consumed even if a clock repeats its version",
  );
  db.prepare(
    "UPDATE openreceive_payments SET status='pending', status_reason='operator_requeued', updated_at=5000",
  ).run();
  const audit = db
    .prepare("SELECT value FROM openreceive_meta WHERE key LIKE 'payment_repair:%'")
    .all();
  assert.equal(audit.length, 1);
  assert.equal(JSON.parse(audit[0].value).statusReason, "not_found_after_expiry");
  assert.ok(!JSON.stringify(audit).includes("test-private"));
  await repository.markPaidOnce({ paymentHash: hash, paidAt: 2600 }, () => {});
  assert.equal(await repository.requeueAttempt(selected), false);
  assert.equal((await repository.listForReference("order"))[0].status, "settled");
});

test("attention requires explicit requeue and a settled sibling prevents duplicate fulfillment", async () => {
  const db = memoryPaymentsDb();
  const repository = createSqlPayments(db, { clock: () => 5000 });
  await repository.commitAttempt(input);
  const siblingHash = "b".repeat(64);
  await repository.commitAttempt({
    ...input,
    paymentHash: siblingHash,
    checkout: { ...input.checkout, paymentHash: siblingHash },
  });
  db.prepare(
    "UPDATE openreceive_payments SET status='attention', status_reason='unsettled_after_expiry', updated_at=3700 WHERE payment_hash=?",
  ).run(hash);
  let fulfilled = 0;
  assert.equal(
    await repository.markPaidOnce({ paymentHash: hash, paidAt: 3900 }, () => {
      fulfilled++;
    }),
    false,
  );
  await repository.markPaidOnce({ paymentHash: siblingHash, paidAt: 4000 }, () => {
    fulfilled++;
  });
  assert.equal(
    await repository.requeueAttempt({
      paymentHash: hash,
      expectedStatus: "attention",
      expectedUpdatedAt: 3700,
      reason: "Reviewed later wallet finality",
    }),
    true,
  );
  await repository.markPaidOnce({ paymentHash: hash, paidAt: 3900 }, () => {
    fulfilled++;
  });
  assert.equal(fulfilled, 1);
  assert.ok((await repository.listForReference("order")).every((row) => row.status === "settled"));
});

for (const boundary of ["before", "after"])
  test(`process termination ${boundary} commit preserves atomic fulfillment across restart`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "openreceive-crash-"));
    const file = path.join(directory, "payments.db");
    let db = new DatabaseSync(file);
    db.exec(paymentsSchemaSql("sqlite"));
    db.exec("CREATE TABLE entitlements(reference TEXT PRIMARY KEY)");
    await createSqlPayments(db).commitAttempt(input);
    db.close();
    const child = fork(
      new URL("./helpers/settlement-crash.mjs", import.meta.url),
      [file, boundary],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    try {
      const [message] = await once(child, "message");
      assert.equal(message, `${boundary}_commit`);
      child.kill("SIGKILL");
      await once(child, "exit");
      db = new DatabaseSync(file);
      const repository = createSqlPayments(db);
      assert.equal(
        (await repository.listForReference("order"))[0].status,
        boundary === "before" ? "pending" : "settled",
      );
      const host = createHost({
        payments: repository,
        amountFor: () => ({ sats: 1 }),
        onPaid: async ({ reference, transaction }) =>
          transaction.query("INSERT INTO entitlements VALUES (?)", [reference]),
      });
      await host.onPaid({ paymentHash: hash, paidAt: 1050 });
      await host.onPaid({ paymentHash: hash, paidAt: 1050 });
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entitlements").get().n, 1);
      db.close();
    } finally {
      child.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  });
