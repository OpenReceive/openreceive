import assert from "node:assert/strict";
import test from "node:test";
import { classifyTransactionSettlement } from "../packages/js/core/src/index.ts";
import {
  createOpenReceive,
  OPENRECEIVE_SWAP_PAY_IN_ASSETS,
} from "../packages/js/node/src/index.ts";
import {
  createTestkitReceiveClient,
  createTestkitSwapProvider,
  TESTKIT_PREIMAGE,
} from "../packages/js/testkit/src/index.ts";

// The settlement rule's own negative case: a preimage without a finality
// signal (settled_at or a settled state) must never settle the attempt.
test("a preimage-only scripted transaction leaves the attempt pending", async () => {
  let now = 1000;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const openreceive = await createOpenReceive({ client: wallet, clock: () => now });

  const checkout = await openreceive.createCheckout({
    orderId: "order-preimage-only",
    amount: { sats: 1000 },
  });

  wallet.scriptTransactionSequence({ payment_hash: checkout.paymentHash }, [
    { state: "pending", preimage: TESTKIT_PREIMAGE },
  ]);

  now = 1100;
  const checked = await openreceive.checkPayment({
    paymentHash: checkout.paymentHash,
    createdAt: checkout.createdAt,
  });
  assert.equal(checked.status, "pending");

  // Script exhausted: the stored invoice still carries the preimage alone.
  const [stored] = wallet
    .listInvoices()
    .filter((transaction) => transaction.payment_hash === checkout.paymentHash);
  assert.equal(stored.preimage, TESTKIT_PREIMAGE);
  assert.equal(classifyTransactionSettlement(stored).settled, false);

  // Positive control: the finality signal is what settles the attempt.
  wallet.settleInvoice({ payment_hash: checkout.paymentHash }, { settled_at: now });
  const settled = await openreceive.checkPayment({
    paymentHash: checkout.paymentHash,
    createdAt: checkout.createdAt,
  });
  assert.equal(settled.status, "settled");
  await openreceive.close();
});

test("a raw preimage-only wallet row (no state, no settled_at) stays pending", async () => {
  let now = 1000;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const openreceive = await createOpenReceive({ client: wallet, clock: () => now });

  const checkout = await openreceive.createCheckout({
    orderId: "order-raw-preimage",
    amount: { sats: 1000 },
  });
  const [minted] = wallet
    .listInvoices()
    .filter((transaction) => transaction.payment_hash === checkout.paymentHash);
  wallet.scriptTransactionSequence({ payment_hash: checkout.paymentHash }, [
    {
      result: {
        type: "incoming",
        invoice: minted.invoice,
        payment_hash: minted.payment_hash,
        amount_msats: minted.amount_msats,
        created_at: minted.created_at,
        expires_at: minted.expires_at,
        preimage: TESTKIT_PREIMAGE,
      },
    },
  ]);

  now = 1100;
  const checked = await openreceive.checkPayment({
    paymentHash: checkout.paymentHash,
    createdAt: checkout.createdAt,
  });
  assert.equal(checked.status, "pending");
  await openreceive.close();
});

test("testkit wallet supports NWC-02 notifications end to end", async () => {
  let now = 1000;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const openreceive = await createOpenReceive({ client: wallet, clock: () => now });

  const received = [];
  const unsubscribe = await openreceive.subscribeWalletNotifications((notification) => {
    received.push(notification);
  });

  const checkout = await openreceive.createCheckout({
    orderId: "order-notify",
    amount: { sats: 1000 },
  });
  now = 1100;
  const transaction = wallet.settleInvoice(
    { payment_hash: checkout.paymentHash },
    { settled_at: now, notify: true },
  );

  assert.equal(received.length, 1);
  assert.equal(received[0].type, "payment_received");
  assert.equal(received[0].payment_hash, checkout.paymentHash);
  assert.deepEqual(received[0].transaction, transaction);
  // The notified payload satisfies the settlement rule, so the listener's
  // direct-settlement path may act on it.
  assert.equal(classifyTransactionSettlement(received[0].transaction).settled, true);

  // Settling without notify emits nothing.
  const second = await openreceive.createCheckout({
    orderId: "order-silent",
    amount: { sats: 1000 },
  });
  wallet.settleInvoice({ payment_hash: second.paymentHash }, { settled_at: now });
  assert.equal(received.length, 1);

  await unsubscribe();
  const third = await openreceive.createCheckout({
    orderId: "order-after-unsubscribe",
    amount: { sats: 1000 },
  });
  wallet.settleInvoice({ payment_hash: third.paymentHash }, { settled_at: now, notify: true });
  assert.equal(received.length, 1);
  await openreceive.close();
});

test("emitNotification mirrors the real client: only payment_received is delivered", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const received = [];
  await wallet.subscribeNotifications((notification) => {
    received.push(notification);
  });
  wallet.emitNotification({ type: "payment_sent" });
  assert.equal(received.length, 0);
  wallet.emitNotification({ type: "payment_received", payment_hash: "a".repeat(64) });
  assert.equal(received.length, 1);
});

test("makeInvoice enforces at most one of description or description_hash", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  await assert.rejects(
    wallet.makeInvoice({
      amount_msats: 1000n,
      description: "either",
      description_hash: "a".repeat(64),
    }),
    /At most one of description or description_hash/,
  );
  await wallet.makeInvoice({ amount_msats: 1000n, description: "alone is fine" });
  await wallet.makeInvoice({ amount_msats: 1000n, description_hash: "a".repeat(64) });
  await wallet.makeInvoice({ amount_msats: 1000n });
});

test("forceRefundRequired and forceAttention queue for attempts created later", async () => {
  const provider = createTestkitSwapProvider({ now: () => 1000 });

  provider.forceRefundRequired("USDT_TRON");
  const refundOrder = await provider.createSwap({
    payInAsset: "USDT_TRON",
    bolt11: "lnbcopenreceive000001",
    invoiceAmountMsats: 1000,
  });
  assert.equal(refundOrder.state, "awaiting_deposit");
  const refundPolled = await provider.getStatus(refundOrder);
  assert.equal(refundPolled.state, "refund_required");

  provider.forceAttention("USDT_SOL", "provider_status_unrecognized");
  const attentionOrder = await provider.createSwap({
    payInAsset: "USDT_SOL",
    bolt11: "lnbcopenreceive000002",
    invoiceAmountMsats: 1000,
  });
  const attentionPolled = await provider.getStatus(attentionOrder);
  assert.equal(attentionPolled.state, "attention");
  assert.equal(attentionPolled.attention, true);
  assert.equal(attentionPolled.attention_reason, "provider_status_unrecognized");
});

test("testkit swap provider serves the canonical @openreceive/node asset catalog", async () => {
  const provider = createTestkitSwapProvider({ now: () => 1000 });
  assert.deepEqual(
    [...(await provider.supportedPayInAssets())].sort(),
    [...OPENRECEIVE_SWAP_PAY_IN_ASSETS].sort(),
  );
  const catalog = await provider.payInAssetCatalog();
  assert.deepEqual(
    catalog.map((asset) => asset.pay_asset).sort(),
    [...OPENRECEIVE_SWAP_PAY_IN_ASSETS].sort(),
  );
});
