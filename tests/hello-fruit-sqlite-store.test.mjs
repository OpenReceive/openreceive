import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOpenReceiveSqlPayments } from "@openreceive/http";
import {
  bootHelloFruitHostStore,
  closeHelloFruitHostStore,
  createHelloFruitHostOrder,
  helloFruitHostDb,
  markHelloFruitOrderPaid,
  readHelloFruitHostOrder,
} from "../examples/hello-fruit/shared/openreceive-store.ts";

const DEMO_ID = "store-test";
const helloFruitRoot = fileURLToPath(new URL("../examples/hello-fruit", import.meta.url));
const openreceiveDir = path.join(helloFruitRoot, ".openreceive");

test("hello fruit host store wipes SQLite, migrates, and serializes attempts", async () => {
  closeHelloFruitHostStore();
  // Remove only this test's own store file — never the whole .openreceive
  // directory, which a concurrently running demo may be using.
  await rm(path.join(openreceiveDir, `${DEMO_ID}.sqlite`), { force: true });

  const logs = [];
  const dbPath = await bootHelloFruitHostStore({
    demoId: DEMO_ID,
    log: (event, message, fields) => {
      logs.push({ event, message, fields });
    },
  });

  assert.match(dbPath, /\.openreceive[/\\]store-test\.sqlite$/);
  await access(dbPath);
  assert.ok(logs.some((entry) => entry.event === "host.store.wipe"));
  assert.ok(logs.some((entry) => entry.event === "host.store.migrate"));
  assert.ok(logs.some((entry) => entry.event === "host.store.ready"));

  const order = createHelloFruitHostOrder(
    {
      uuid: "order-1",
      status: "pending_payment",
      items: [],
      total_amount: { currency: "USD", value: "1.00" },
    },
    { currency: "USD", value: "1.00" },
  );
  assert.equal(readHelloFruitHostOrder("order-1")?.summary.uuid, order.summary.uuid);

  // Payment attempts are library-owned rows in the host database.
  const payments = createOpenReceiveSqlPayments(helloFruitHostDb());
  const expiresAt = Math.floor(Date.now() / 1_000) + 600;
  const createdAt = Math.floor(Date.now() / 1_000);
  await payments.commitAttempt({
    orderId: "order-1",
    paymentHash: "a".repeat(64),
    checkout: {
      orderId: "order-1",
      paymentHash: "a".repeat(64),
      bolt11: "lnbc1test",
      amountMsats: 1000,
      createdAt,
      expiresAt,
    },
  });
  const stored = await payments.listForOrder("order-1");
  assert.equal(stored[0].status, "pending");
  assert.equal(stored[0].checkout.bolt11, "lnbc1test");
  assert.equal(stored[0].createdAt, createdAt);
  assert.deepEqual(await payments.listReconcilableAttempts(), [
    { paymentHash: "a".repeat(64), createdAt, expiresAt },
  ]);

  await assert.rejects(
    () =>
      payments.commitAttempt({
        orderId: "order-1",
        paymentHash: "b".repeat(64),
        checkout: {
          orderId: "order-1",
          paymentHash: "b".repeat(64),
          bolt11: "lnbc1test2",
          amountMsats: 1000,
          createdAt,
          expiresAt,
        },
      }),
    /already in progress for this order/i,
  );

  // Settlement is write-once; fulfillment runs inside the transaction exactly once.
  const paidAt = Math.floor(Date.now() / 1_000);
  let fulfillments = 0;
  const fulfill = async (settlement) => {
    fulfillments += 1;
    const paid = await markHelloFruitOrderPaid(settlement);
    assert.equal(paid?.summary.status, "paid");
  };
  await payments.markPaidOnce({ paymentHash: "a".repeat(64), paidAt }, fulfill);
  assert.equal(fulfillments, 1);
  assert.equal(readHelloFruitHostOrder("order-1")?.summary.status, "paid");
  const settled = await payments.listForOrder("order-1");
  assert.equal(settled[0].status, "settled");
  assert.equal(settled[0].paidAt, paidAt);
  assert.deepEqual(await payments.listReconcilableAttempts(), []);

  // Replay is harmless: the settled row is never rewritten and never refulfills.
  await payments.markPaidOnce({ paymentHash: "a".repeat(64), paidAt }, fulfill);
  assert.equal(fulfillments, 1);

  closeHelloFruitHostStore();
  const relaunchLogs = [];
  await bootHelloFruitHostStore({
    demoId: DEMO_ID,
    log: (event) => {
      relaunchLogs.push(event);
    },
  });
  assert.deepEqual(
    relaunchLogs.filter((event) => event.startsWith("host.store.")),
    ["host.store.wipe", "host.store.migrate", "host.store.ready"],
  );
  assert.equal(readHelloFruitHostOrder("order-1"), null);

  closeHelloFruitHostStore();
  await rm(path.join(openreceiveDir, `${DEMO_ID}.sqlite`), { force: true });
});
