import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  bootHelloFruitHostStore,
  closeHelloFruitHostStore,
  createHelloFruitHostOrder,
  helloFruitPaymentRepository,
  markHelloFruitPaid,
  readHelloFruitHostOrder,
} from "../../examples/hello-fruit/shared/openreceive-store.ts";

const DEMO_ID = "store-test";
const helloFruitRoot = fileURLToPath(new URL("../../examples/hello-fruit", import.meta.url));
const openreceiveDir = path.join(helloFruitRoot, ".openreceive");

test("hello fruit host store wipes SQLite, migrates, and serializes attempts", async () => {
  closeHelloFruitHostStore();
  await rm(openreceiveDir, { recursive: true, force: true });

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

  const expiresAt = Math.floor(Date.now() / 1_000) + 600;
  const createdAt = Math.floor(Date.now() / 1_000);
  await helloFruitPaymentRepository.commitAttempt({
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
  const stored = await helloFruitPaymentRepository.listForOrder("order-1");
  assert.equal(stored[0].checkout.bolt11, "lnbc1test");
  assert.equal(stored[0].createdAt, createdAt);
  assert.deepEqual(await helloFruitPaymentRepository.listUnsettledAttempts(), [
    { paymentHash: "a".repeat(64), createdAt },
  ]);

  await assert.rejects(
    () =>
      helloFruitPaymentRepository.commitAttempt({
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
    /live payment attempt|paid or live/i,
  );

  const paid = markHelloFruitPaid("a".repeat(64), Math.floor(Date.now() / 1_000));
  assert.equal(paid?.summary.status, "paid");
  assert.equal(readHelloFruitHostOrder("order-1")?.summary.status, "paid");

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
  await rm(openreceiveDir, { recursive: true, force: true });
});
