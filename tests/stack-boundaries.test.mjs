import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenReceiveStack,
  isOpenReceiveStackOptions,
} from "../packages/js/http/src/index.ts";

const authorize = () => true;

function stubPayments() {
  return {
    listForOrder: async () => [],
    commitAttempt: async () => {},
    listReconcilableAttempts: async () => [],
    recordReconciliation: async () => {},
    recordSettlement: async () => false,
    claimReconcileGate: async () => false,
  };
}

test("isOpenReceiveStackOptions routes composed and flat forms", () => {
  assert.equal(
    isOpenReceiveStackOptions({ service: {}, host: {}, authorize }),
    false,
    "composed form with host must not enter the all-in-one path",
  );
  assert.equal(
    isOpenReceiveStackOptions({
      nwc: "nostr+walletconnect://example",
      db: {},
      loadOrder: async () => null,
      amountForOrder: () => ({ sats: 1000 }),
      onPaid: async () => {},
      authorize,
    }),
    true,
  );
  assert.equal(
    isOpenReceiveStackOptions({
      service: {},
      payments: stubPayments(),
      loadOrder: async () => null,
      amountForOrder: () => ({ sats: 1000 }),
      onSettlement: async () => {},
      authorize,
    }),
    true,
    "flat form with a prebuilt service still carries the order hooks",
  );
});

test("composed options missing host throw the missing-host error", () => {
  assert.throws(
    () => isOpenReceiveStackOptions({ service: {}, authorize }),
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
  const stack = createOpenReceiveStack({
    service,
    payments: stubPayments(),
    loadOrder: async () => null,
    amountForOrder: () => ({ sats: 1000 }),
    onSettlement: async () => {},
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
  const stack = createOpenReceiveStack({
    service: Promise.reject(new Error("boot failed")),
    payments: stubPayments(),
    loadOrder: async () => null,
    amountForOrder: () => ({ sats: 1000 }),
    onSettlement: async () => {},
    authorize,
  });
  await stack.ready.catch(() => {});
  await stack.close();
});
