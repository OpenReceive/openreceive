import assert from "node:assert/strict";
import test from "node:test";
import { createStack, isStackOptions } from "../packages/js/http/src/index.ts";
import {
  BOOT_RETRY_FIRST_MS,
  BOOT_RETRY_MAX_MS,
  createRetryingBoot,
} from "../packages/js/http/src/stack.ts";

const authorize = () => true;

function stubPayments() {
  return {
    listForReference: async () => [],
    commitAttempt: async () => {},
    listReconcilableAttempts: async () => [],
    recordReconciliation: async () => {},
    findByPaymentHash: async (paymentHash) => ({ paymentHash, status: "settled" }),
    recordSettlementWithFulfillment: async () => false,
    claimReconcileGate: async () => null,
    checkpointReconcileGate: async () => true,
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

test("a failed boot answers 503 and leaves no unhandled rejection", async () => {
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    // The host never touches `ready`, as a server that only mounts the handler.
    const stack = createStack({
      wallet: { service: Promise.reject(new Error("boot failed")) },
      storage: { payments: stubPayments(), onPaid: async () => {} },
      amountFor: () => ({ sats: 1000 }),
      authorize,
      onBootFailure: () => {},
    });
    const response = await stack.handler(
      new Request("http://localhost/openreceive/checkouts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference: "order-1" }),
      }),
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "WALLET_UNAVAILABLE");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
    await assert.rejects(stack.ready, /boot failed/);
    await stack.close();
  } finally {
    process.off("unhandledRejection", record);
  }
});

test("a relay that does not answer at start resolves ready and answers 503", async () => {
  const lines = [];
  const stack = createStack({
    // Nothing listens on port 1, so the relay refuses at once.
    wallet: {
      nwc: `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2F127.0.0.1%3A1&secret=${"b".repeat(64)}`,
    },
    storage: { payments: stubPayments(), onPaid: async () => {} },
    amountFor: () => ({ sats: 1000 }),
    authorize,
    onBootFailure: (line) => lines.push(line),
  });
  await stack.ready;
  assert.match(lines[0], /could not reach the wallet's relay/);
  const response = await stack.handler(
    new Request("http://localhost/openreceive/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: "order-1" }),
    }),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "WALLET_UNAVAILABLE");
  await stack.close();
});

test("a code that can never work rejects ready", async () => {
  const stack = createStack({
    wallet: { nwc: "not-a-wallet-code" },
    storage: { payments: stubPayments(), onPaid: async () => {} },
    amountFor: () => ({ sats: 1000 }),
    authorize,
    onBootFailure: () => {},
  });
  await assert.rejects(stack.ready, { name: "ConfigError" });
  await stack.close();
});

test("a failed boot is retried by the first request after the wait, and serves it", async () => {
  let clock = 0;
  let attempts = 0;
  const failures = [];
  const boot = createRetryingBoot(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("NWC wallet service request timed out.");
      return "handler";
    },
    {
      retries: true,
      onFailure: (_error, retryAfterMs) => failures.push(retryAfterMs),
      now: () => clock,
    },
  );
  await assert.rejects(boot.current(), /timed out/);
  assert.deepEqual(failures, [BOOT_RETRY_FIRST_MS]);
  // Inside the wait, requests get the failed attempt without touching the wallet.
  clock = BOOT_RETRY_FIRST_MS - 1;
  await assert.rejects(boot.current(), /timed out/);
  assert.equal(attempts, 1);
  // The first request after the wait boots again; concurrent ones share it.
  clock = BOOT_RETRY_FIRST_MS;
  const [a, b] = await Promise.all([boot.current(), boot.current()]);
  assert.equal(a, "handler");
  assert.equal(b, "handler");
  assert.equal(attempts, 2);
  // `first` still reports the first boot.
  await assert.rejects(boot.first, /timed out/);
  await boot.stop();
});

test("each failed retry doubles the wait, up to the cap", async () => {
  let clock = 0;
  const waits = [];
  const boot = createRetryingBoot(
    async () => {
      throw new Error("relay down");
    },
    {
      retries: true,
      onFailure: (_error, retryAfterMs) => waits.push(retryAfterMs),
      now: () => clock,
    },
  );
  for (let i = 0; i < 9; i += 1) {
    await boot.current().catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    clock += BOOT_RETRY_MAX_MS;
  }
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  assert.equal(BOOT_RETRY_MAX_MS, 60_000);
  await boot.stop();
});

test("a host-supplied service is not retried, and stop() ends retries", async () => {
  let clock = 0;
  let attempts = 0;
  const fail = async () => {
    attempts += 1;
    throw new Error("boot failed");
  };
  const hostOwned = createRetryingBoot(fail, {
    retries: false,
    onFailure: (_error, retryAfterMs) => assert.equal(retryAfterMs, undefined),
    now: () => clock,
  });
  await hostOwned.current().catch(() => {});
  clock = BOOT_RETRY_MAX_MS * 10;
  await hostOwned.current().catch(() => {});
  assert.equal(attempts, 1);

  attempts = 0;
  clock = 0;
  const owned = createRetryingBoot(fail, { retries: true, onFailure: () => {}, now: () => clock });
  await owned.current().catch(() => {});
  await owned.stop();
  clock = BOOT_RETRY_MAX_MS;
  await owned.current().catch(() => {});
  assert.equal(attempts, 1, "a closed stack never opens another relay connection");
});
