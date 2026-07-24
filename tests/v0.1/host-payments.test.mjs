import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenReceiveHost,
  openReceivePaymentInsert,
  startOpenReceiveReconciler,
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
  const paymentHash = hash(character);
  return {
    orderId: "order-1",
    paymentHash,
    paidAt: null,
    createdAt: 900,
    expiresAt: 1_100,
    checkout: {
      orderId: "order-1",
      paymentHash,
      bolt11: `lnbc-${character}`,
      amountMsats: 1_000,
      createdAt: 900,
      expiresAt: 1_100,
      fiatQuote: null,
    },
    ...overrides,
  };
}

function host(rows) {
  return createOpenReceiveHost({
    clock: () => 1_000,
    loadOrder: async (orderId) => (orderId === "order-1" ? { total: "10.00" } : null),
    amountForOrder: (order) => ({ currency: "USD", value: order.total }),
    payments: {
      listForOrder: async () => rows,
      commitAttempt: async () => undefined,
      listUnsettledAttempts: async () => [],
    },
    onPaid: async () => undefined,
  });
}

test("host integration allows multiple expired attempts and reuses the one live attempt", async () => {
  const resolved = await host([
    payment("a", { createdAt: 700, expiresAt: 800 }),
    payment("b", { createdAt: 800, expiresAt: 900 }),
    payment("c"),
  ]).resolveCheckout(context("checkout.create"));

  assert.deepEqual(resolved, {
    amount: { currency: "USD", value: "10.00" },
    paymentHash: hash("c"),
    checkout: payment("c").checkout,
  });
});

test("host integration creates a new attempt after every previous attempt expires", async () => {
  const resolved = await host([
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
  const selected = await host(rows).resolveCheckout(
    context("payment.check", { payment_hash: hash("a") }),
  );
  assert.equal(selected.paymentHash, hash("a"));

  await assert.rejects(
    host(rows).resolveCheckout(context("payment.check", { payment_hash: hash("f") })),
    /Payment attempt not found for this order/,
  );
});

test("host integration fails closed when repository corruption exposes two live attempts", async () => {
  await assert.rejects(
    host([payment("a", { createdAt: 800 }), payment("b", { createdAt: 900 })]).resolveCheckout(
      context("checkout.create"),
    ),
    /multiple live payment attempts/,
  );
});

test("host integration blocks another checkout once any attempt paid", async () => {
  await assert.rejects(
    host([
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
  const paymentHost = host([payment("a", { swapData })]);

  const sameAsset = await paymentHost.resolveCheckout(
    context("swap.create", { pay_in_asset: "USDT_TRON" }, "USDT_TRON"),
  );
  assert.equal(sameAsset.paymentHash, hash("a"));
  assert.equal(sameAsset.swapData, swapData);

  await assert.rejects(
    paymentHost.resolveCheckout(context("swap.create", { pay_in_asset: "USDC_SOL" }, "USDC_SOL")),
    /another asset/,
  );
  await assert.rejects(
    paymentHost.resolveCheckout(context("checkout.create")),
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
      return new Response(
        JSON.stringify({
          payment_hash: paymentHash,
          status: "pending",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  await refresh("order-1");
  assert.deepEqual(requestBody, {
    order_id: "order-1",
    payment_hash: paymentHash,
  });
});

test("reconciler retries from host-owned unsettled attempts without a cursor", async () => {
  const paymentHash = hash("a");
  const controller = new AbortController();
  const inputs = [];
  const delivered = [];
  const returned = await startOpenReceiveReconciler({
    service: {
      async reconcilePayments(input) {
        inputs.push(input);
        return [{ paymentHash, status: "settled", paidAt: 900 }];
      },
    },
    host: {
      onPaid: async (payment) => {
        delivered.push(payment);
        if (delivered.length === 1) throw new Error("host transaction rolled back");
        controller.abort();
      },
      payments: {
        listUnsettledAttempts: async () => [{ paymentHash, createdAt: 800 }],
      },
    },
    signal: controller.signal,
    pollIntervalMs: 250,
  });
  await returned.done;
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], {
    attempts: [{ paymentHash, createdAt: 800 }],
    overlapSeconds: 60,
  });
  assert.deepEqual(delivered.map((payment) => payment.paymentHash), [paymentHash, paymentHash]);
});
