import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryInvoiceKvStore, StaticPriceProvider } from "../../packages/js/core/src/index.ts";
import {
  createOpenReceive,
  describeSwapState,
  OPENRECEIVE_SWAP_STATES,
} from "../../packages/js/node/src/index.ts";
import { mergeSwapConfig } from "../../packages/js/node/src/service/bootstrap.ts";
import {
  createTestkitReceiveClient,
  createTestkitSwapProvider,
} from "../../packages/js/testkit/src/index.ts";

async function harness(swapProvider) {
  let now = 1000;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const openreceive = await createOpenReceive({
    configPath: false,
    client: wallet,
    store: new InMemoryInvoiceKvStore(),
    namespace: "swap_dx_test",
    clock: () => now,
    priceProviders: [new StaticPriceProvider()],
    swap: { providers: swapProvider === undefined ? [] : [swapProvider] },
  });
  return {
    openreceive,
    advance(seconds) {
      now += seconds;
    },
  };
}

test("createTestkitSwapProvider drives a scripted swap lifecycle offline", async () => {
  const swap = createTestkitSwapProvider({ now: () => 1000 });
  const { openreceive, advance } = await harness(swap);
  await openreceive.createCheckout({
    orderId: "order-testkit",
    amount: { btc: { currency: "SATS", value: "200" } },
  });

  swap.script("USDT_TRON", ["confirming", "exchanging", "completed"]);
  const attempt = await openreceive.startSwap({
    orderId: "order-testkit",
    payInAsset: "USDT_TRON",
  });
  // First-class attempt: deposit fields are top-level, invoice is nested.
  assert.equal(attempt.provider_state, "awaiting_deposit");
  assert.equal(attempt.deposit_address, "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");
  assert.equal(attempt.pay_in_asset, "USDT_TRON");
  assert.equal(attempt.shadow_invoice.rail, "swap");
  assert.equal("provider_token" in attempt, false);

  const readState = async () => {
    advance(11);
    const order = await openreceive.getOrder({ orderId: "order-testkit" });
    return order.active_checkout.invoices.find((invoice) => invoice.rail === "swap").swap
      .provider_state;
  };

  assert.equal(await readState(), "confirming");
  assert.equal(await readState(), "exchanging");
  assert.equal(await readState(), "completed");

  // Provider "completed" must NOT mark the order paid (wallet sweep is authority).
  const order = await openreceive.getOrder({ orderId: "order-testkit" });
  assert.equal(order.status, "pending");
});

test("createTestkitSwapProvider forces refund_required and attention with a reason", async () => {
  const swap = createTestkitSwapProvider({ now: () => 1000 });
  const { openreceive, advance } = await harness(swap);
  await openreceive.createCheckout({
    orderId: "order-testkit-refund",
    amount: { btc: { currency: "SATS", value: "200" } },
  });
  const attempt = await openreceive.startSwap({
    orderId: "order-testkit-refund",
    payInAsset: "ETH_ETH",
  });

  swap.forceRefundRequired("ETH_ETH");
  advance(11);
  const refreshed = await openreceive.getOrder({ orderId: "order-testkit-refund" });
  const swapInvoice = refreshed.active_checkout.invoices.find((invoice) => invoice.rail === "swap");
  assert.equal(swapInvoice.swap.provider_state, "refund_required");
  assert.match(swapInvoice.swap.refund_nonce, /^or_ref_[a-f0-9]{32}$/);
  assert.equal(typeof swapInvoice.swap.refund_nonce_expires_at, "number");

  const staged = await openreceive.refundSwap({
    attemptId: attempt.attempt_id,
    refundAddress: "0x2222222222222222222222222222222222222222",
    refundNonce: swapInvoice.swap.refund_nonce,
  });
  assert.equal(staged.provider_state, "refund_required");
  assert.deepEqual(swap.refundCalls, []);

  const confirmed = await openreceive.refundSwap({
    attemptId: attempt.attempt_id,
    refundAddress: "0x2222222222222222222222222222222222222222",
    refundNonce: staged.refund_nonce,
    confirm: true,
  });
  assert.equal(confirmed.provider_state, "refund_pending");
  assert.equal(swap.refundCalls.length, 1);
});

test("createTestkitSwapProvider surfaces an attention reason on the payload", async () => {
  const swap = createTestkitSwapProvider({ now: () => 1000 });
  const { openreceive, advance } = await harness(swap);
  await openreceive.createCheckout({
    orderId: "order-testkit-attention",
    amount: { btc: { currency: "SATS", value: "200" } },
  });
  await openreceive.startSwap({ orderId: "order-testkit-attention", payInAsset: "SOL_SOL" });

  swap.forceAttention("SOL_SOL", "provider_completed_without_wallet_settlement");
  advance(11);
  const order = await openreceive.getOrder({ orderId: "order-testkit-attention" });
  const swapInvoice = order.active_checkout.invoices.find((invoice) => invoice.rail === "swap");
  assert.equal(swapInvoice.swap.provider_state, "attention");
  assert.equal(swapInvoice.swap.attention, true);
  assert.equal(swapInvoice.swap.attention_reason, "provider_completed_without_wallet_settlement");
});

test("describeSwapState maps every provider state and keeps completed non-terminal", () => {
  assert.equal(Object.keys(OPENRECEIVE_SWAP_STATES).length, 12);

  const completed = describeSwapState("completed");
  assert.equal(completed.terminal, false);
  assert.equal(completed.phase, "settling");
  assert.equal(completed.label, "Finalizing checkout");

  assert.equal(describeSwapState("awaiting_deposit").phase, "awaiting_deposit");
  assert.equal(describeSwapState("refund_required").phase, "refund");
  assert.equal(describeSwapState("refunded").terminal, true);
  assert.equal(describeSwapState("expired").terminal, true);
  assert.equal(describeSwapState("failed").terminal, true);
  assert.equal(describeSwapState("attention").terminal, true);

  // Unknown states fall back safely instead of throwing.
  const unknown = describeSwapState("some_future_state");
  assert.equal(unknown.phase, "attention");
  assert.equal(unknown.label, "some_future_state");
});

test("mergeSwapConfig combines file and programmatic providers instead of replacing", () => {
  const fileProvider = { name: "fixedfloat" };
  const codeProvider = { name: "myboltz" };
  const overrideProvider = { name: "fixedfloat" };

  // Programmatic providers append new names and override same-name file entries in place.
  const merged = mergeSwapConfig(
    { providers: [fileProvider], settlementAttentionSeconds: 60 },
    { providers: [overrideProvider, codeProvider], settlementAttentionSeconds: 30 },
  );
  assert.deepEqual(
    merged.providers.map((provider) => provider.name),
    ["fixedfloat", "myboltz"],
  );
  assert.equal(merged.providers[0], overrideProvider);
  assert.equal(merged.settlementAttentionSeconds, 30);

  // Missing sides pass through unchanged.
  assert.deepEqual(mergeSwapConfig(undefined, { providers: [codeProvider] }), {
    providers: [codeProvider],
  });
  assert.deepEqual(mergeSwapConfig({ providers: [fileProvider] }, undefined), {
    providers: [fileProvider],
  });
});
