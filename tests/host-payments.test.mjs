import assert from "node:assert/strict";
import test from "node:test";
import { hash } from "./helpers/factories.mjs";
import {
  createHost,
  reconcileHostPayments,
  startReconciler,
} from "../packages/js/http/src/index.ts";
import { paymentInsert } from "../packages/js/http/src/payment-repository.ts";
import { createStatusFetcher } from "../packages/js/browser/src/headless.ts";

function context(action, input = {}, payInAsset) {
  return {
    action,
    request: new Request("http://test/openreceive"),
    reference: "order-1",
    input,
    ...(payInAsset === undefined ? {} : { payInAsset }),
  };
}

function payment(character, overrides = {}) {
  const paymentHash = hash(character);
  return {
    reference: "order-1",
    paymentHash,
    status: "pending",
    statusReason: null,
    paidAt: null,
    createdAt: 900,
    expiresAt: 1_100,
    checkout: {
      reference: "order-1",
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
    listForReference: async () => rows,
    commitAttempt: async () => undefined,
    listReconcilableAttempts: async () => [],
    recordReconciliation: async () => undefined,
    recordSettlement: async () => true,
  };
}

function host(rows) {
  return createHost({
    clock: () => 1_000,
    amountFor: async (reference) =>
      reference === "order-1" ? { currency: "USD", value: "10.00" } : null,
    payments: repository(rows),
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
    /Payment attempt not found for this reference/,
  );
});

test("host integration fails closed when repository corruption exposes two live attempts", async () => {
  const error = await host([payment("a", { createdAt: 800 }), payment("b", { createdAt: 900 })])
    .resolveCheckout(context("checkout.create"))
    .then(
      () => assert.fail("two live attempts for one method must not resolve"),
      (thrown) => thrown,
    );
  assert.equal(error.status, 409);
  assert.match(error.message, /unpaid checkouts in progress/);
  // The forbidden internal vocabulary never reaches the payer.
  assert.doesNotMatch(error.message, /live|supersede/i);
});

test("a pending superseded row never blocks its live replacement from being reused", async () => {
  // Supersede keeps the old row pending with a future expires_at; only the
  // statusReason marks it dead. The newer sibling must be served without a 409.
  const resolved = await host([
    payment("a", { statusReason: "superseded" }),
    payment("b", { createdAt: 950 }),
  ]).resolveCheckout(context("checkout.create"));

  assert.deepEqual(resolved, {
    amount: { currency: "USD", value: "10.00" },
    paymentHash: hash("b"),
    checkout: payment("b").checkout,
  });
});

test("a lone pending superseded row mints fresh instructions, never its stale ones", async () => {
  const resolved = await host([payment("a", { statusReason: "superseded" })]).resolveCheckout(
    context("checkout.create"),
  );
  assert.deepEqual(resolved, { amount: { currency: "USD", value: "10.00" } });
});

test("a hash-hinted create refuses a pending superseded attempt", async () => {
  await assert.rejects(
    host([payment("a", { statusReason: "superseded" })]).resolveCheckout(
      context("checkout.create", { payment_hash: hash("a") }),
    ),
    /not a reusable pending checkout/,
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
    const selected = await host(rows).resolveCheckout(context(action, { payment_hash: hash("b") }));
    assert.equal(selected.paymentHash, hash("b"));
    assert.equal(selected.swapData, swapData);
  }
});

test("status and refund actions require a payment hash", async () => {
  // Every HTTP route for these actions carries payment_hash; a hash-less call
  // is a caller bug, not an invitation to guess an attempt.
  for (const action of ["payment.check", "swap.read", "swap.refund"]) {
    await assert.rejects(
      host([payment("a")]).resolveCheckout(context(action)),
      /payment_hash is required/,
    );
  }
});

test("host pricing runs only when minting or quoting, never on status or refund reads", async () => {
  let priced = 0;
  const paymentHost = createHost({
    clock: () => 1_000,
    amountFor: () => {
      priced += 1;
      throw new Error("pricing service down");
    },
    payments: repository([payment("a")]),
    onPaid: async () => undefined,
  });
  for (const action of ["payment.check", "swap.read", "swap.refund"]) {
    const selected = await paymentHost.resolveCheckout(
      context(action, { payment_hash: hash("a") }),
    );
    assert.equal(selected.paymentHash, hash("a"));
    assert.equal(selected.amount, undefined);
  }
  assert.equal(priced, 0, "a slow or broken pricing callback must not break status polls");
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

test("createHost requires the host hooks and a db or full payments repository", () => {
  const amountFor = () => ({ sats: 1 });
  const onPaid = async () => undefined;
  const payments = repository([]);

  assert.throws(() => createHost({}), /requires amountFor/);
  assert.throws(() => createHost({ amountFor }), /requires onPaid/);
  assert.throws(
    () => createHost({ amountFor, onPaid }),
    /requires db or payments\.listForReference/,
  );
  assert.throws(
    () =>
      createHost({
        amountFor,
        onPaid,
        payments: { listForReference: payments.listForReference },
      }),
    /requires payments\.commitAttempt/,
  );
  assert.throws(
    () =>
      createHost({
        amountFor,
        onPaid,
        payments: {
          listForReference: payments.listForReference,
          commitAttempt: payments.commitAttempt,
        },
      }),
    /requires payments\.listReconcilableAttempts/,
  );
  assert.throws(
    () =>
      createHost({
        amountFor,
        onPaid,
        payments: {
          listForReference: payments.listForReference,
          commitAttempt: payments.commitAttempt,
          listReconcilableAttempts: payments.listReconcilableAttempts,
        },
      }),
    /requires payments\.recordReconciliation/,
  );
  // A complete custom repository is the documented escape hatch.
  const built = createHost({ amountFor, onPaid, payments });
  assert.equal(built.payments, payments);
});

test("a custom repository drives the library's write-once settlement claim", async () => {
  const paymentHash = hash("a");
  const claims = [];
  const notified = [];
  // The repository owns storage; the LIBRARY owns the state machine: it asks
  // for the first-settlement claim and calls the host only when it is won.
  const claimResults = [true, false];
  const built = createHost({
    amountFor: () => ({ currency: "USD", value: "1.00" }),
    payments: {
      ...repository([]),
      recordSettlement: async (settlement) => {
        claims.push(settlement);
        return claimResults.shift() ?? false;
      },
    },
    onPaid: async (settlement) => notified.push(settlement.paymentHash),
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
      createHost({
        amountFor: () => ({ currency: "USD", value: "1.00" }),
        payments: withoutClaim,
        onPaid: async () => assert.fail("settlement must not reach the host unclaimed"),
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
    paymentInsert({
      reference: "order-1",
      paymentHash: hash("a").toUpperCase(),
      checkout: {
        reference: "order-1",
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
      reference: "order-1",
      paymentHash: hash("a"),
      createdAt: 1_000,
      expiresAt: 1_050,
      checkout: {
        reference: "order-1",
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
  const refresh = createStatusFetcher({
    prefix: "/openreceive",
    snapshot: {
      checkout_id: paymentHash,
      reference: "order-1",
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
    reference: "order-1",
    payment_hash: paymentHash,
  });
});

test("reconciler retries from the pending-attempt ledger without a cursor", async () => {
  const paymentHash = hash("a");
  const controller = new AbortController();
  const inputs = [];
  const delivered = [];
  const gateClaims = [];
  const returned = await startReconciler({
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
        claimReconcileGate: async (input) => {
          gateClaims.push(input);
          return true;
        },
      },
    },
    signal: controller.signal,
    pollIntervalMs: 250,
    onError: () => undefined,
  });
  await returned.done;
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], {
    attempts: [{ paymentHash, createdAt: 800, expiresAt: 1_100 }],
    overlapSeconds: 60,
    maxPages: 50,
  });
  assert.deepEqual(
    delivered.map((settled) => settled.paymentHash),
    [paymentHash, paymentHash],
  );
  // Every worker pass goes through the durable gate.
  assert.equal(gateClaims.length, 2);
});

test("reconciler refuses a repository without the durable scan gate", async () => {
  await assert.rejects(
    startReconciler({
      service: { reconcilePayments: async () => [] },
      host: {
        onPaid: async () => undefined,
        payments: {
          listReconcilableAttempts: async () => [],
          recordReconciliation: async () => undefined,
        },
      },
    }),
    /claimReconcileGate/,
  );
});

test("one failing settlement delivery does not starve the rest of the pass", async () => {
  const delivered = [];
  const service = {
    reconcilePayments: async () => [
      { paymentHash: hash("a"), status: "settled", paidAt: 900 },
      { paymentHash: hash("b"), status: "settled", paidAt: 901 },
    ],
  };
  const failingHost = {
    onPaid: async (settled) => {
      delivered.push(settled.paymentHash);
      if (settled.paymentHash === hash("a")) throw new Error("host transaction rolled back");
    },
    payments: {
      listReconcilableAttempts: async () => [
        { paymentHash: hash("a"), createdAt: 800, expiresAt: 1_100 },
        { paymentHash: hash("b"), createdAt: 800, expiresAt: 1_100 },
      ],
      recordReconciliation: async () => undefined,
    },
  };
  await assert.rejects(reconcileHostPayments({ service, host: failingHost }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(error.errors[0].message, /host transaction rolled back/);
    return true;
  });
  // The failure on the first check must not stop the second delivery.
  assert.deepEqual(delivered, [hash("a"), hash("b")]);
});
