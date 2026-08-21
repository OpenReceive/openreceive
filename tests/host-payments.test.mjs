import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenReceiveHost,
  openReceivePaymentInsert,
  startOpenReceiveReconciler,
} from "../packages/js/http/src/index.ts";
import { createOpenReceiveStatusFetcher } from "../packages/js/browser/src/internal.ts";

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
    status: "pending",
    statusReason: null,
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

function repository(rows) {
  return {
    listForOrder: async () => rows,
    commitAttempt: async () => undefined,
    listReconcilableAttempts: async () => [],
    recordReconciliation: async () => undefined,
    recordSettlement: async () => true,
  };
}

function host(rows) {
  return createOpenReceiveHost({
    clock: () => 1_000,
    loadOrder: async (orderId) => (orderId === "order-1" ? { total: "10.00" } : null),
    amountForOrder: (order) => ({ currency: "USD", value: order.total }),
    payments: repository(rows),
    onSettlement: async () => undefined,
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

test("host integration ignores terminal-status rows even when their expiry is in the future", async () => {
  // A superseded row keeps its future expires_at but must never be reused.
  const resolved = await host([
    payment("a", { status: "expired", statusReason: "superseded" }),
    payment("b", { status: "failed", createdAt: 950 }),
  ]).resolveCheckout(context("checkout.create"));

  assert.deepEqual(resolved, { amount: { currency: "USD", value: "10.00" } });
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

test("host integration blocks another checkout once any attempt settled", async () => {
  const error = await host([
    payment("a", { status: "settled", paidAt: 950, expiresAt: 980 }),
    payment("b", { createdAt: 800, expiresAt: 900 }),
  ])
    .resolveCheckout(context("checkout.create"))
    .then(
      () => assert.fail("settled order must not mint another attempt"),
      (thrown) => thrown,
    );
  assert.match(error.message, /already paid/);
  assert.equal(error.status, 409);
  assert.equal(error.body.code, "CONFLICT");
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

  // Different asset / Lightning may mint while the other rail stays live.
  assert.deepEqual(
    await paymentHost.resolveCheckout(
      context("swap.create", { pay_in_asset: "USDC_SOL" }, "USDC_SOL"),
    ),
    { amount: { currency: "USD", value: "10.00" } },
  );
  assert.deepEqual(await paymentHost.resolveCheckout(context("checkout.create")), {
    amount: { currency: "USD", value: "10.00" },
  });
});

test("swap.read and swap.refund select the attempt carrying swap data", async () => {
  const swapData = {
    version: 1,
    providerOrder: {
      provider: "test",
      provider_order_id: "provider-2",
      provider_token: "server-only",
      pay_in_asset: "USDT_TRON",
      deposit_address: "T-address",
      deposit_amount: "1",
      expires_at: 1_050,
      state: "awaiting_deposit",
    },
  };
  const rows = [payment("a"), payment("b", { createdAt: 800, swapData })];
  for (const action of ["swap.read", "swap.refund"]) {
    const selected = await host(rows).resolveCheckout(context(action));
    assert.equal(selected.paymentHash, hash("b"));
    assert.equal(selected.swapData, swapData);
  }
});

test("host integration reuses Lightning and allows a concurrent swap mint", async () => {
  const paymentHost = host([payment("c")]);
  const lightning = await paymentHost.resolveCheckout(context("checkout.create"));
  assert.equal(lightning.paymentHash, hash("c"));

  assert.deepEqual(await paymentHost.resolveCheckout(context("swap.create", {}, "SOL_SOL")), {
    amount: { currency: "USD", value: "10.00" },
  });
});

test("host integration remints when the matching attempt is near expiry", async () => {
  const nearExpiry = payment("c", { expiresAt: 1_030 }); // clock is 1000; buffer is 60
  assert.deepEqual(await host([nearExpiry]).resolveCheckout(context("checkout.create")), {
    amount: { currency: "USD", value: "10.00" },
  });
});

test("createOpenReceiveHost requires the order hooks and a db or full payments repository", () => {
  const loadOrder = async () => null;
  const amountForOrder = () => ({ sats: 1 });
  const onPaid = async () => undefined;
  const onSettlement = async () => undefined;
  const payments = repository([]);

  assert.throws(() => createOpenReceiveHost({}), /requires loadOrder/);
  assert.throws(() => createOpenReceiveHost({ loadOrder }), /requires amountForOrder/);
  assert.throws(() => createOpenReceiveHost({ loadOrder, amountForOrder }), /requires onPaid/);
  assert.throws(
    () => createOpenReceiveHost({ loadOrder, amountForOrder, onPaid }),
    /requires db or payments\.listForOrder/,
  );
  assert.throws(
    () =>
      createOpenReceiveHost({
        loadOrder,
        amountForOrder,
        onSettlement,
        payments: { listForOrder: payments.listForOrder },
      }),
    /requires payments\.commitAttempt/,
  );
  assert.throws(
    () =>
      createOpenReceiveHost({
        loadOrder,
        amountForOrder,
        onSettlement,
        payments: {
          listForOrder: payments.listForOrder,
          commitAttempt: payments.commitAttempt,
        },
      }),
    /requires payments\.listReconcilableAttempts/,
  );
  assert.throws(
    () =>
      createOpenReceiveHost({
        loadOrder,
        amountForOrder,
        onSettlement,
        payments: {
          listForOrder: payments.listForOrder,
          commitAttempt: payments.commitAttempt,
          listReconcilableAttempts: payments.listReconcilableAttempts,
        },
      }),
    /requires payments\.recordReconciliation/,
  );
  // A complete custom repository is the documented escape hatch.
  const built = createOpenReceiveHost({ loadOrder, amountForOrder, onSettlement, payments });
  assert.equal(built.payments, payments);
});

test("a custom repository drives the library's write-once settlement claim", async () => {
  const paymentHash = hash("a");
  const claims = [];
  const notified = [];
  // The repository owns storage; the LIBRARY owns the state machine: it asks
  // for the first-settlement claim and calls the host only when it is won.
  const claimResults = [true, false];
  const built = createOpenReceiveHost({
    loadOrder: async () => ({ total: "1.00" }),
    amountForOrder: () => ({ currency: "USD", value: "1.00" }),
    payments: {
      ...repository([]),
      recordSettlement: async (settlement) => {
        claims.push(settlement);
        return claimResults.shift() ?? false;
      },
    },
    onSettlement: async (settlement) => notified.push(settlement.paymentHash),
  });

  await built.onPaid({ paymentHash, paidAt: 990 });
  await built.onPaid({ paymentHash, paidAt: 990 });

  assert.deepEqual(
    claims.map((claim) => claim.paymentHash),
    [paymentHash, paymentHash],
  );
  assert.deepEqual(notified, [paymentHash], "a redelivered settlement must not fulfill twice");
});

test("a custom repository without recordSettlement is refused at construction", () => {
  const { recordSettlement: _omitted, ...withoutClaim } = repository([]);
  // Refused alongside the other required repository methods rather than at the
  // first settlement: a host must not discover this once money has arrived.
  assert.throws(
    () =>
      createOpenReceiveHost({
        loadOrder: async () => ({ total: "1.00" }),
        amountForOrder: () => ({ currency: "USD", value: "1.00" }),
        payments: withoutClaim,
        onSettlement: async () => assert.fail("settlement must not reach the host unclaimed"),
      }),
    /requires payments\.recordSettlement/,
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

test("reconciler retries from the pending-attempt ledger without a cursor", async () => {
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
      onPaid: async (settled) => {
        delivered.push(settled);
        if (delivered.length === 1) throw new Error("host transaction rolled back");
        controller.abort();
      },
      payments: {
        listReconcilableAttempts: async () => [{ paymentHash, createdAt: 800, expiresAt: 1_100 }],
        recordReconciliation: async () => undefined,
      },
    },
    signal: controller.signal,
    pollIntervalMs: 250,
  });
  await returned.done;
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], {
    attempts: [{ paymentHash, createdAt: 800, expiresAt: 1_100 }],
    overlapSeconds: 60,
  });
  assert.deepEqual(
    delivered.map((settled) => settled.paymentHash),
    [paymentHash, paymentHash],
  );
});
