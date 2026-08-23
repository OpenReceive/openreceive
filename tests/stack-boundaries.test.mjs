import assert from "node:assert/strict";
import test from "node:test";
import { createStack, isStackOptions } from "../packages/js/http/src/index.ts";

const authorize = () => true;

function stubPayments() {
  return {
    listForReference: async () => [],
    commitAttempt: async () => {},
    listReconcilableAttempts: async () => [],
    recordReconciliation: async () => {},
    recordSettlement: async () => false,
    claimReconcileGate: async () => false,
  };
}

test("isStackOptions routes composed and flat forms", () => {
  assert.equal(
    isStackOptions({ service: {}, host: {}, authorize }),
    false,
    "composed form with host must not enter the all-in-one path",
  );
  assert.equal(
    isStackOptions({
      nwc: "nostr+walletconnect://example",
      db: {},
      amountFor: () => ({ sats: 1000 }),
      onPaid: async () => {},
      authorize,
    }),
    true,
  );
  assert.equal(
    isStackOptions({
      service: {},
      payments: stubPayments(),
      amountFor: () => ({ sats: 1000 }),
      onPaid: async () => {},
      authorize,
    }),
    true,
    "flat form with a prebuilt service still carries the order hooks",
  );
});

test("composed options missing host throw the missing-host error", () => {
  assert.throws(
    () => isStackOptions({ service: {}, authorize }),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /require host/);
      assert.doesNotMatch(error.message, /nwc or service/);
      return true;
    },
  );
});

test("stack close() during an in-flight boot waits for the boot to finish", async () => {
  let resolveService;
  const service = new Promise((resolve) => {
    resolveService = resolve;
  });
  const stack = createStack({
    wallet: { service },
    storage: { payments: stubPayments(), onPaid: async () => {} },
    amountFor: () => ({ sats: 1000 }),
    authorize,
  });
  let booted = false;
  stack.ready.then(() => {
    booted = true;
  });
  let closed = false;
  const closing = stack.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false, "close() must not resolve while boot is in flight");
  resolveService({ close: async () => {} });
  await closing;
  assert.equal(booted, true, "close() resolves only after the boot finished");
});

test("stack close() resolves even when boot fails", async () => {
  const stack = createStack({
    wallet: { service: Promise.reject(new Error("boot failed")) },
    storage: { payments: stubPayments(), onPaid: async () => {} },
    amountFor: () => ({ sats: 1000 }),
    authorize,
  });
  await stack.ready.catch(() => {});
  await stack.close();
});
