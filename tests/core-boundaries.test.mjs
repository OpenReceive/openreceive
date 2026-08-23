import assert from "node:assert/strict";
import test from "node:test";
import {
  checkPayment,
  DecimalError,
  OpenReceiveError,
  reconcilePaymentAttempts,
} from "../packages/js/core/src/index.ts";

const hash = (value) => value.toString(16).padStart(64, "0");

test("payment scans page at 20, deduplicate hashes, and require settlement authority", async () => {
  const requests = [];
  const transactions = Array.from({ length: 21 }, (_, index) => ({
    type: "incoming",
    payment_hash: hash(index + 1),
    created_at: 100 + index,
    transaction_state: index === 20 ? "settled" : "pending",
    ...(index === 0 ? { preimage: "f".repeat(64) } : {}),
    ...(index === 20 ? { settled_at: 500 } : {}),
  }));
  const client = {
    async preflight() {
      return {};
    },
    async makeInvoice() {
      throw new Error("unused");
    },
    async listTransactions(request) {
      requests.push(request);
      return { transactions: transactions.slice(request.offset, request.offset + request.limit) };
    },
  };

  const [settled] = await reconcilePaymentAttempts({
    client,
    attempts: [{ paymentHash: hash(21), createdAt: 120 }],
    until: 1000,
  });
  assert.equal(settled.status, "settled");
  assert.equal(settled.paymentHash, hash(21));
  assert.deepEqual(
    requests.map((request) => request.limit),
    [20, 20],
  );
  assert.deepEqual(
    requests.map((request) => request.offset),
    [0, 20],
  );

  requests.length = 0;
  const preimageOnly = await checkPayment({
    client,
    paymentHash: hash(1),
    createdAt: 100,
    clock: () => 999,
  });
  assert.equal(preimageOnly.status, "pending");
  assert.equal(preimageOnly.paidAt, undefined);
});

test("state=settled without settled_at uses observed time and identifies its source", async () => {
  const paymentHash = hash(42);
  const client = {
    async preflight() {
      return {};
    },
    async makeInvoice() {
      throw new Error("unused");
    },
    async listTransactions() {
      return { transactions: [{ payment_hash: paymentHash, state: "settled" }] };
    },
  };
  const result = await checkPayment({
    client,
    paymentHash,
    createdAt: 700,
    clock: () => 777,
  });
  assert.equal(result.status, "settled");
  assert.equal(result.paidAt, 777);
  assert.equal(result.details.paid_at_source, "observed_at");
});

test("a truncated scan surfaces as a retryable WALLET_UNAVAILABLE, never a bare Error", async () => {
  // A wallet that ignores `offset` serves the same full page forever, so the
  // walk ends truncated without ever proving the invoice present or absent.
  const page = Array.from({ length: 20 }, (_, index) => ({
    type: "incoming",
    payment_hash: hash(index + 1),
    created_at: 100 + index,
    transaction_state: "pending",
  }));
  const client = {
    async preflight() {
      return {};
    },
    async makeInvoice() {
      throw new Error("unused");
    },
    async listTransactions() {
      return { transactions: page };
    },
  };
  await assert.rejects(
    checkPayment({ client, paymentHash: hash(999), createdAt: 100, clock: () => 1000 }),
    (error) => {
      // The HTTP layer maps a retryable core error code to a retryable 5xx
      // (503), so this must never be a generic Error that reads as a 500.
      assert.ok(error instanceof OpenReceiveError);
      assert.equal(error.code, "WALLET_UNAVAILABLE");
      assert.equal(error.retryable, true);
      assert.match(error.message, /wallet history walk ended/);
      return true;
    },
  );
});

test("malformed reconcile inputs throw the 400-mapped DecimalError", async () => {
  const client = {
    async preflight() {
      return {};
    },
    async makeInvoice() {
      throw new Error("unused");
    },
    async listTransactions() {
      return { transactions: [] };
    },
  };
  const inputError = (options) =>
    assert.rejects(reconcilePaymentAttempts({ client, ...options }), (error) => {
      assert.ok(error instanceof DecimalError);
      // The Node service maps payer/host input errors to 400 by RangeError.
      assert.ok(error instanceof RangeError);
      return true;
    });
  await inputError({ attempts: [{ paymentHash: "nope", createdAt: 100 }] });
  await inputError({ attempts: [{ paymentHash: hash(1), createdAt: -1 }] });
  await inputError({ attempts: [{ paymentHash: hash(1), createdAt: 100 }], overlapSeconds: -1 });
  await inputError({ attempts: [{ paymentHash: hash(1), createdAt: 100 }], maxPages: 0 });
});
