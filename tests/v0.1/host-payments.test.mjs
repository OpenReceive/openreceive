import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenReceivePaymentHooks,
  openReceivePaymentInsert,
} from "@openreceive/http";
import { createOpenReceiveStatusFetcher } from "@openreceive/browser/internal";

const hash = (character) => character.repeat(64);

function context(action, input = {}, payInAsset) {
  return {
    action,
    request: new Request("http://test/openreceive"),
    orderId: "order-1",
    input,
    ...(payInAsset === undefined ? {} : { payInAsset }),
  };
}

function payment(character, overrides = {}) {
  return {
    orderId: "order-1",
    paymentHash: hash(character),
    paidAt: null,
    createdAt: 900,
    expiresAt: 1_100,
    ...overrides,
  };
}

function hooks(rows) {
  return createOpenReceivePaymentHooks({
    clock: () => 1_000,
    loadOrder: async (orderId) =>
      orderId === "order-1" ? { total: "10.00" } : null,
    amountForOrder: (order) => ({ currency: "USD", value: order.total }),
    payments: {
      listForOrder: async () => rows,
      commitAttempt: async () => undefined,
    },
  });
}

test("payment hooks allow multiple expired attempts and reuse the one live attempt", async () => {
  const resolved = await hooks([
    payment("a", { createdAt: 700, expiresAt: 800 }),
    payment("b", { createdAt: 800, expiresAt: 900 }),
    payment("c"),
  ]).resolveCheckout(context("checkout.create"));

  assert.deepEqual(resolved, {
    amount: { currency: "USD", value: "10.00" },
    paymentHash: hash("c"),
  });
});

test("payment hooks create a new attempt after every previous attempt expires", async () => {
  const resolved = await hooks([
    payment("a", { createdAt: 700, expiresAt: 800 }),
    payment("b", { createdAt: 800, expiresAt: 900 }),
  ]).resolveCheckout(context("checkout.create"));

  assert.deepEqual(resolved, {
    amount: { currency: "USD", value: "10.00" },
  });
});

test("payment status selects the exact attempt only after checking order ownership", async () => {
  const rows = [
    payment("a", { createdAt: 700, expiresAt: 800 }),
    payment("b", { createdAt: 800, expiresAt: 900 }),
  ];
  const selected = await hooks(rows).resolveCheckout(
    context("payment.check", { payment_hash: hash("a") }),
  );
  assert.equal(selected.paymentHash, hash("a"));

  await assert.rejects(
    hooks(rows).resolveCheckout(
      context("payment.check", { payment_hash: hash("f") }),
    ),
    /Payment attempt not found for this order/,
  );
});

test("payment hooks fail closed when repository corruption exposes two live attempts", async () => {
  await assert.rejects(
    hooks([
      payment("a", { createdAt: 800 }),
      payment("b", { createdAt: 900 }),
    ]).resolveCheckout(context("checkout.create")),
    /multiple live payment attempts/,
  );
});

test("payment hooks block another checkout once any attempt paid", async () => {
  await assert.rejects(
    hooks([
      payment("a", { paidAt: 950, expiresAt: 980 }),
      payment("b", { createdAt: 800, expiresAt: 900 }),
    ]).resolveCheckout(context("checkout.create")),
    /already paid/,
  );
});

test("one payment row binds one swap attempt and one pay-in asset", async () => {
  const swapData = {
    version: 1,
    providerOrder: {
      provider: "test",
      provider_order_id: "provider-1",
      provider_token: "server-only",
      pay_in_asset: "USDT_TRON",
      deposit_address: "T-address",
      deposit_amount: "1",
      expires_at: 1_050,
      state: "awaiting_deposit",
    },
  };
  const paymentHooks = hooks([payment("a", { swapData })]);

  const sameAsset = await paymentHooks.resolveCheckout(
    context("swap.create", { pay_in_asset: "USDT_TRON" }, "USDT_TRON"),
  );
  assert.equal(sameAsset.paymentHash, hash("a"));
  assert.equal(sameAsset.swapData, swapData);

  await assert.rejects(
    paymentHooks.resolveCheckout(
      context("swap.create", { pay_in_asset: "USDC_SOL" }, "USDC_SOL"),
    ),
    /another asset/,
  );
  await assert.rejects(
    paymentHooks.resolveCheckout(context("checkout.create")),
    /live swap attempt/,
  );
});

test("payment insert uses provider expiry and keeps swap data server-side", () => {
  const swapData = {
    version: 1,
    providerOrder: {
      provider: "test",
      provider_order_id: "provider-1",
      provider_token: "server-only",
      pay_in_asset: "USDT_TRON",
      deposit_address: "T-address",
      deposit_amount: "1",
      expires_at: 1_050,
      state: "awaiting_deposit",
    },
  };
  assert.deepEqual(
    openReceivePaymentInsert({
      orderId: "order-1",
      paymentHash: hash("a").toUpperCase(),
      checkout: {
        orderId: "order-1",
        paymentHash: hash("a"),
        bolt11: "lnbc1",
        amountMsats: 1_000,
        createdAt: 1_000,
        expiresAt: 1_100,
        fiatQuote: null,
      },
      swapData,
    }),
    {
      orderId: "order-1",
      paymentHash: hash("a"),
      createdAt: 1_000,
      expiresAt: 1_050,
      swapData,
    },
  );
});

test("browser status polling carries the displayed payment hash", async () => {
  let requestBody;
  const paymentHash = hash("a");
  const invoice = {
    invoice_id: paymentHash,
    rail: "lightning",
    payment_hash: paymentHash,
    amount_msats: 1_000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
  };
  const refresh = createOpenReceiveStatusFetcher({
    orderUrl: "/openreceive/payments/check",
    snapshot: {
      checkout_id: paymentHash,
      order_id: "order-1",
      status: "open",
      active: invoice,
      invoices: [invoice],
    },
    fetch: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        payment_hash: paymentHash,
        status: "pending",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await refresh("order-1");
  assert.deepEqual(requestBody, {
    order_id: "order-1",
    payment_hash: paymentHash,
  });
});
