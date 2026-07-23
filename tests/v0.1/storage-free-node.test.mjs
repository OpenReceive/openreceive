import assert from "node:assert/strict";
import test from "node:test";
import { createOpenReceive } from "../../packages/js/node/src/index.ts";
import {
  createTestkitReceiveClient,
  createTestkitSwapProvider,
} from "../../packages/js/testkit/src/index.ts";

test("Node service creates without persistence and verifies by payment_hash", async () => {
  let now = 1000;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const openreceive = await createOpenReceive({
    client: wallet,
    clock: () => now,
  });

  const first = await openreceive.createCheckout({
    orderId: "order-1",
    amount: { currency: "USD", value: "10.00" },
  });
  const second = await openreceive.createCheckout({
    orderId: "order-1",
    amount: { currency: "USD", value: "10.00" },
  });
  assert.notEqual(first.paymentHash, second.paymentHash, "host payment repository is the guard");
  assert.equal(
    (await openreceive.checkPayment({ paymentHash: first.paymentHash })).status,
    "pending",
  );

  now = 1100;
  wallet.settleInvoice({ payment_hash: first.paymentHash }, { settled_at: now });
  const paid = await openreceive.checkPayment({ paymentHash: first.paymentHash });
  assert.equal(paid.status, "settled");
  assert.equal(paid.paidAt, 1100);

  await openreceive.close();
});

test("watchPayments retries a failed callback and delivers settlement at least once", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const openreceive = await createOpenReceive({
    client: wallet,
    clock: () => 1000,
  });
  const checkout = await openreceive.createCheckout({
    orderId: "retry-paid",
    amount: { sats: 1000 },
  });
  wallet.settleInvoice({ payment_hash: checkout.paymentHash }, { settled_at: 1010 });
  let deliveries = 0;
  let watcher;
  watcher = openreceive.watchPayments({
    from: 0,
    pollIntervalMs: 250,
    onPaid: async (payment) => {
      deliveries += 1;
      assert.equal(payment.paymentHash, checkout.paymentHash);
      if (deliveries === 1) throw new Error("host transaction rolled back");
      watcher.stop();
    },
  });
  await watcher.done;
  assert.equal(deliveries, 2);
  await openreceive.close();
});

test("host-serialized swap data recovers provider state and provider state controls refunds", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const provider = createTestkitSwapProvider({ now: () => 1000 });
  const openreceive = await createOpenReceive({
    client: wallet,
    swap: { providers: [provider] },
    clock: () => 1000,
  });
  const swap = await openreceive.createSwap({
    orderId: "swap-1",
    amount: { sats: 20_000 },
    payInAsset: "USDT_TRON",
  });
  assert.equal(swap.swapData.version, 1);
  assert.equal(swap.swapData.paymentHash, undefined);
  assert.equal(swap.swapData.orderId, undefined);
  const storedSwapData = JSON.parse(JSON.stringify(swap.swapData));

  provider.forceRefundRequired({ providerOrderId: "testkit-swap-1" });
  const status = await openreceive.getSwap({
    orderId: swap.orderId,
    paymentHash: swap.paymentHash,
    swapData: storedSwapData,
  });
  assert.equal(status.providerState, "refund_required");
  const refunded = await openreceive.refundSwap({
    orderId: swap.orderId,
    paymentHash: swap.paymentHash,
    swapData: storedSwapData,
    refundAddress: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
  });
  assert.equal(refunded.providerState, "refund_pending");
});
