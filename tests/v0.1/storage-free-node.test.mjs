import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createOpenReceive, createStatelessTokenManager } from "../../packages/js/node/src/index.ts";
import {
  createTestkitReceiveClient,
  createTestkitSwapProvider,
} from "../../packages/js/testkit/src/index.ts";

const key = Buffer.alloc(32, 7).toString("base64url");

test("Node opens the shared authenticated token envelope", () => {
  const vector = JSON.parse(readFileSync("spec/test-vectors/stateless-token.json", "utf8"));
  const manager = createStatelessTokenManager({ keys: vector.keyring, clock: () => 1000 });
  const opened = manager.open(vector.cross_language.purpose, vector.cross_language.token);
  for (const [name, value] of Object.entries(vector.cross_language.payload)) {
    assert.deepEqual(opened[name], value);
  }
  assert.throws(() => manager.open("swap", vector.cross_language.token));
  const parts = vector.cross_language.token.split(".");
  parts[4] = `${parts[4][0] === "A" ? "B" : "A"}${parts[4].slice(1)}`;
  assert.throws(() => manager.open("cap", parts.join(".")));
  assert.throws(() => createStatelessTokenManager({
    keys: vector.keyring,
    clock: () => vector.cross_language.payload.expiresAt,
  }).open("cap", vector.cross_language.token));

  const previousOnly = createStatelessTokenManager({
    keys: [vector.keyring[1]],
    clock: () => 1000,
  });
  const oldToken = previousOnly.seal("cap", vector.cross_language.payload);
  assert.match(oldToken, /^or_cap_v1\.previous\./);
  assert.equal(manager.open("cap", oldToken).orderId, "crosslang");
  assert.match(manager.seal("cap", vector.cross_language.payload), /^or_cap_v1\.current\./);
});

test("Node service creates without persistence and verifies by payment_hash", async () => {
  let now = 1000;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const openreceive = await createOpenReceive({
    client: wallet,
    tokenKeys: [{ id: "current", key }],
    clock: () => now,
    configPath: false,
  });

  const first = await openreceive.createCheckout({
    orderId: "order-1",
    amount: { currency: "USD", value: "10.00" },
  });
  const second = await openreceive.createCheckout({
    orderId: "order-1",
    amount: { currency: "USD", value: "10.00" },
  });
  assert.notEqual(first.paymentHash, second.paymentHash, "host row is the idempotency guard");
  assert.equal((await openreceive.checkPayment({ paymentHash: first.paymentHash })).status, "pending");

  now = 1100;
  wallet.settleInvoice({ payment_hash: first.paymentHash }, { settled_at: now });
  const paid = await openreceive.checkPayment({ paymentHash: first.paymentHash });
  assert.equal(paid.status, "settled");
  assert.equal(paid.paidAt, 1100);

  const capability = await openreceive.mintCapabilityToken({
    orderId: "order-1",
    paymentHash: first.paymentHash,
    expiresAt: 1200,
  });
  assert.match(capability, /^or_cap_v1\./);
  assert.equal((await openreceive.verifyCapabilityToken(capability)).paymentHash, first.paymentHash);
  await openreceive.close();
});

test("watchPayments retries a failed callback and delivers settlement at least once", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const openreceive = await createOpenReceive({
    client: wallet,
    tokenKeys: [{ id: "current", key }],
    clock: () => 1000,
    configPath: false,
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

test("swap recovery token is opaque and provider state controls refunds", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const provider = createTestkitSwapProvider({ now: () => 1000 });
  const openreceive = await createOpenReceive({
    client: wallet,
    tokenKeys: [{ id: "current", key }],
    swap: { providers: [provider] },
    clock: () => 1000,
    configPath: false,
  });
  const swap = await openreceive.createSwap({
    orderId: "swap-1",
    amount: { sats: 20_000 },
    payInAsset: "USDT_TRON",
  });
  assert.match(swap.swapRecoveryToken, /^or_swap_v1\./);
  assert.doesNotMatch(swap.swapRecoveryToken, /testkit-token/);

  provider.forceRefundRequired({ providerOrderId: "testkit-swap-1" });
  const status = await openreceive.getSwap({ recoveryToken: swap.swapRecoveryToken });
  assert.equal(status.providerState, "refund_required");
  const confirmation = await openreceive.createSwapRefundConfirmation({
    recoveryToken: swap.swapRecoveryToken,
    refundAddress: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
  });
  const refunded = await openreceive.refundSwap({
    recoveryToken: swap.swapRecoveryToken,
    refundAddress: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
    confirmationToken: confirmation.confirmationToken,
  });
  assert.equal(refunded.providerState, "refund_pending");
});
