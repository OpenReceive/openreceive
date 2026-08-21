import assert from "node:assert/strict";
import test from "node:test";
import { VALID_NWC, hash, memoryPaymentsDb } from "./helpers/factories.mjs";
import { until } from "./helpers/lifecycle-harness.mjs";
import { OpenReceiveError } from "../packages/js/core/src/index.ts";
import { createNwcReceiveClient, createOpenReceive } from "../packages/js/node/src/index.ts";
import {
  createOpenReceiveHost,
  startOpenReceiveNotificationListener,
} from "../packages/js/http/src/index.ts";

const RECEIVE_ONLY_INFO = {
  capabilities: ["make_invoice", "list_transactions"],
  encryptions: ["nip44_v2"],
  notifications: ["payment_received", "payment_sent"],
};

function notifyingSdkClient({ subscription } = {}) {
  const sdk = {
    callbacks: [],
    subscribedTypes: undefined,
    unsubscribed: 0,
    getWalletServiceInfo: async () => RECEIVE_ONLY_INFO,
    subscribeNotifications: async (callback, notificationTypes) => {
      sdk.callbacks.push(callback);
      sdk.subscribedTypes = notificationTypes;
      if (subscription !== undefined) return subscription(sdk);
      return () => {
        sdk.unsubscribed += 1;
      };
    },
  };
  return sdk;
}

// Waiting uses the shared lifecycle-harness `until` (generous deadline, labeled
// timeouts) instead of a tight local wall-clock loop that flaked under load.

test("client subscribeNotifications requests only payment_received and normalizes payloads", async () => {
  const sdk = notifyingSdkClient();
  const client = createNwcReceiveClient({ connectionString: VALID_NWC, client: sdk });
  const received = [];

  const unsubscribe = await client.subscribeNotifications((notification) => {
    received.push(notification);
  });
  assert.deepEqual(sdk.subscribedTypes, ["payment_received"]);

  sdk.callbacks[0]({
    notification_type: "payment_received",
    notification: { payment_hash: hash("c"), preimage: "corroborating-only", amount: 1_000 },
  });
  sdk.callbacks[0]({
    notification_type: "payment_sent",
    notification: { payment_hash: hash("d") },
  });
  // The payload is normalized exactly like a list_transactions row.
  assert.deepEqual(received, [
    {
      type: "payment_received",
      payment_hash: hash("c"),
      transaction: {
        payment_hash: hash("c"),
        amount_msats: 1_000n,
        preimage: "corroborating-only",
      },
    },
  ]);

  await unsubscribe();
  assert.equal(sdk.unsubscribed, 1);
});

test("client subscribeNotifications carries the settlement finality signal through", async () => {
  const sdk = notifyingSdkClient();
  const client = createNwcReceiveClient({ connectionString: VALID_NWC, client: sdk });
  const received = [];
  await client.subscribeNotifications((notification) => {
    received.push(notification);
  });

  sdk.callbacks[0]({
    notification_type: "payment_received",
    notification: {
      type: "incoming",
      state: "settled",
      payment_hash: hash("c"),
      amount: 1_000,
      settled_at: 990,
    },
  });
  assert.deepEqual(received, [
    {
      type: "payment_received",
      payment_hash: hash("c"),
      transaction: {
        type: "incoming",
        payment_hash: hash("c"),
        amount_msats: 1_000n,
        transaction_state: "settled",
        settled_at: 990,
      },
    },
  ]);
});

test("client subscribeNotifications survives a malformed payload as a hash-only hint", async () => {
  const sdk = notifyingSdkClient();
  const client = createNwcReceiveClient({ connectionString: VALID_NWC, client: sdk });
  const received = [];
  await client.subscribeNotifications((notification) => {
    received.push(notification);
  });

  sdk.callbacks[0]({
    notification_type: "payment_received",
    notification: { payment_hash: hash("c"), amount: "not-an-integer" },
  });
  // Tolerant normalization degrades the unparsable amount to "field absent";
  // the hash still arrives and the amount-less transaction can never satisfy
  // the settlement rule, so it only wakes reconciliation.
  assert.deepEqual(received, [
    {
      type: "payment_received",
      payment_hash: hash("c"),
      transaction: { payment_hash: hash("c") },
    },
  ]);
});

test("client subscribeNotifications handles a subscription-object unsubscribe shape", async () => {
  let unsubbed = 0;
  const sdk = notifyingSdkClient({
    subscription: () => ({
      unsub() {
        unsubbed += 1;
      },
    }),
  });
  const client = createNwcReceiveClient({ connectionString: VALID_NWC, client: sdk });
  const unsubscribe = await client.subscribeNotifications(() => {});
  await unsubscribe();
  assert.equal(unsubbed, 1);
});

test("client subscribeNotifications rejects UNSUPPORTED_METHOD when the wallet lacks it", async () => {
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: { getWalletServiceInfo: async () => RECEIVE_ONLY_INFO },
  });
  await assert.rejects(
    () => client.subscribeNotifications(() => {}),
    (error) => {
      assert.ok(error instanceof OpenReceiveError);
      assert.equal(error.code, "UNSUPPORTED_METHOD");
      assert.match(error.message, /does not support NWC notifications/);
      return true;
    },
  );
});

test("service subscribeWalletNotifications delegates to a notification-capable client", async () => {
  const sdk = notifyingSdkClient();
  const service = await createOpenReceive({
    client: createNwcReceiveClient({ connectionString: VALID_NWC, client: sdk }),
    logging: { enabled: false, console: false },
  });
  const received = [];
  const unsubscribe = await service.subscribeWalletNotifications((notification) => {
    received.push(notification);
  });
  sdk.callbacks[0]({
    notification_type: "payment_received",
    notification: { payment_hash: hash("e") },
  });
  assert.deepEqual(received, [
    {
      type: "payment_received",
      payment_hash: hash("e"),
      transaction: { payment_hash: hash("e") },
    },
  ]);
  await unsubscribe();
  assert.equal(sdk.unsubscribed, 1);
  await service.close();
});

test("service subscribeWalletNotifications rejects UNSUPPORTED_METHOD without client support", async () => {
  const service = await createOpenReceive({
    client: createNwcReceiveClient({
      connectionString: VALID_NWC,
      client: { getWalletServiceInfo: async () => RECEIVE_ONLY_INFO },
    }),
    logging: { enabled: false, console: false },
  });
  await assert.rejects(
    () => service.subscribeWalletNotifications(() => {}),
    (error) => error instanceof OpenReceiveError && error.code === "UNSUPPORTED_METHOD",
  );
  await service.close();
});

function scriptedNotifierService(reconcilePayments) {
  const notifier = { handler: undefined, unsubscribed: 0, reconcileCalls: 0 };
  const service = {
    reconcilePayments: async (input) => {
      notifier.reconcileCalls += 1;
      return reconcilePayments(input);
    },
    subscribeWalletNotifications: async (handler) => {
      notifier.handler = handler;
      return () => {
        notifier.unsubscribed += 1;
      };
    },
  };
  return { service, notifier };
}

function sqliteHostWithPendingAttempt({ paymentHash, onPaid }) {
  const db = memoryPaymentsDb();
  const host = createOpenReceiveHost({
    db,
    loadOrder: async () => ({ total: "10.00" }),
    amountForOrder: () => ({ sats: 100 }),
    onPaid,
  });
  // A live attempt relative to the real clock so a fallback scan pass never
  // closes it as expired.
  const now = Math.floor(Date.now() / 1_000);
  return {
    host,
    commit: () =>
      host.onCheckoutCreated({
        orderId: "order-1",
        paymentHash,
        checkout: {
          orderId: "order-1",
          paymentHash,
          bolt11: "lnbc-f",
          amountMsats: 1_000,
          createdAt: now - 100,
          expiresAt: now + 600,
          fiatQuote: null,
        },
      }),
  };
}

test("a settled notification payload settles the pending attempt directly with zero scans", async () => {
  const paymentHash = hash("f");
  const settled = [];
  const { host, commit } = sqliteHostWithPendingAttempt({
    paymentHash,
    onPaid: (settlement) => {
      settled.push({
        orderId: settlement.orderId,
        paymentHash: settlement.paymentHash,
        paidAt: settlement.paidAt,
        paidAtSource: settlement.details?.paid_at_source,
      });
    },
  });
  await commit();

  const { service, notifier } = scriptedNotifierService(async () => {
    throw new Error("direct settlement must never trigger a wallet scan");
  });
  const listener = await startOpenReceiveNotificationListener({ service, host });

  notifier.handler({
    type: "payment_received",
    payment_hash: paymentHash,
    transaction: {
      type: "incoming",
      payment_hash: paymentHash,
      amount_msats: 1_000n,
      transaction_state: "settled",
      settled_at: 990,
      preimage: "corroborating-only",
    },
  });
  await until(() => settled.length === 1, { label: "the settlement to run" });
  assert.deepEqual(settled, [
    { orderId: "order-1", paymentHash, paidAt: 990, paidAtSource: "settled_at" },
  ]);
  const rows = await host.payments.listForOrder("order-1");
  assert.equal(rows[0].status, "settled");
  assert.equal(rows[0].paidAt, 990);
  assert.equal(notifier.reconcileCalls, 0, "a settled notification never wakes a wallet scan");
  // The settled attempt left the pending set, so nothing remains to scan.
  assert.deepEqual(await host.payments.listReconcilableAttempts(), []);

  await listener.stop();
  assert.equal(notifier.unsubscribed, 1);
});

test("a payload without a finality signal only wakes a reconcile pass", async () => {
  const paymentHash = hash("f");
  const settled = [];
  const { host, commit } = sqliteHostWithPendingAttempt({
    paymentHash,
    onPaid: (settlement) => {
      settled.push(settlement.paymentHash);
    },
  });
  await commit();

  const { service, notifier } = scriptedNotifierService(async ({ attempts }) =>
    attempts.map((attempt) => ({
      paymentHash: attempt.paymentHash,
      status: "settled",
      paidAt: 990,
    })),
  );
  const listener = await startOpenReceiveNotificationListener({ service, host });

  // A preimage alone is corroborating evidence, never finality.
  notifier.handler({
    type: "payment_received",
    payment_hash: paymentHash,
    transaction: { payment_hash: paymentHash, preimage: "corroborating-only" },
  });
  await until(() => settled.length === 1, { label: "the settlement to run" });
  assert.equal(notifier.reconcileCalls, 1, "the settlement came from the wallet scan");
  const rows = await host.payments.listForOrder("order-1");
  assert.equal(rows[0].status, "settled");

  await listener.stop();
});

test("a settled payload for an unknown hash settles nothing and wakes a reconcile pass", async () => {
  const paymentHash = hash("f");
  const settled = [];
  const { host, commit } = sqliteHostWithPendingAttempt({
    paymentHash,
    onPaid: (settlement) => {
      settled.push(settlement.paymentHash);
    },
  });
  await commit();

  const { service, notifier } = scriptedNotifierService(async ({ attempts }) =>
    attempts.map((attempt) => ({ paymentHash: attempt.paymentHash, status: "pending" })),
  );
  const listener = await startOpenReceiveNotificationListener({ service, host });

  const unknownHash = hash("e");
  notifier.handler({
    type: "payment_received",
    payment_hash: unknownHash,
    transaction: {
      payment_hash: unknownHash,
      transaction_state: "settled",
      settled_at: 990,
    },
  });
  await until(() => notifier.reconcileCalls === 1, { label: "the woken reconcile pass" });
  assert.deepEqual(settled, [], "an unknown hash never settles anything directly");
  const rows = await host.payments.listForOrder("order-1");
  assert.equal(rows[0].status, "pending");

  await listener.stop();
});

test("a direct-settlement failure reports to onError and falls back to a scan", async () => {
  const paymentHash = hash("f");
  const errors = [];
  let failOnce = true;
  const scanned = [];
  const { host, commit } = sqliteHostWithPendingAttempt({
    paymentHash,
    onPaid: () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("settlement transaction failed");
      }
    },
  });
  await commit();

  const { service, notifier } = scriptedNotifierService(async ({ attempts }) => {
    scanned.push(attempts.map((attempt) => attempt.paymentHash));
    return attempts.map((attempt) => ({ paymentHash: attempt.paymentHash, status: "pending" }));
  });
  const listener = await startOpenReceiveNotificationListener({
    service,
    host,
    onError: (error) => errors.push(error),
  });

  notifier.handler({
    type: "payment_received",
    transaction: { payment_hash: paymentHash, transaction_state: "settled", settled_at: 990 },
  });
  await until(() => errors.length === 1 && notifier.reconcileCalls === 1, {
    label: "the onError report plus the fallback scan",
  });
  assert.match(errors[0].message, /settlement transaction failed/);
  assert.deepEqual(scanned, [[paymentHash]], "the safety-net scan still covers the attempt");

  await listener.stop();
});

test("notification listener wakes one reconcile pass that settles a pending sqlite attempt", async () => {
  const paymentHash = hash("f");
  const settled = [];
  const { host, commit } = sqliteHostWithPendingAttempt({
    paymentHash,
    onPaid: (settlement) => {
      settled.push({ orderId: settlement.orderId, paymentHash: settlement.paymentHash });
    },
  });
  await commit();

  const { service, notifier } = scriptedNotifierService(async ({ attempts }) =>
    attempts.map((attempt) => ({
      paymentHash: attempt.paymentHash,
      status: "settled",
      paidAt: 990,
    })),
  );
  const listener = await startOpenReceiveNotificationListener({ service, host });

  // Without a payload the notification is only a wake-up hint; the scan settles.
  notifier.handler({ type: "payment_received", payment_hash: paymentHash });
  await until(() => settled.length === 1, { label: "the settlement to run" });
  assert.deepEqual(settled, [{ orderId: "order-1", paymentHash }]);
  const rows = await host.payments.listForOrder("order-1");
  assert.equal(rows[0].status, "settled");

  await listener.stop();
  assert.equal(notifier.unsubscribed, 1);
});

test("notification listener coalesces bursts and stop() unsubscribes", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const passes = [];
  const host = {
    payments: {
      listForOrder: async () => [],
      listReconcilableAttempts: async () => [
        { paymentHash: hash("b"), createdAt: 900, expiresAt: 1_600 },
      ],
      commitAttempt: async () => undefined,
      recordReconciliation: async () => undefined,
      claimReconcileGate: async () => true,
    },
    resolveCheckout: async () => ({ amount: { sats: 100 } }),
    onCheckoutCreated: async () => undefined,
    onPaid: async () => undefined,
  };
  const { service, notifier } = scriptedNotifierService(async ({ attempts }) => {
    passes.push(Date.now());
    await gate;
    return attempts.map((attempt) => ({ paymentHash: attempt.paymentHash, status: "pending" }));
  });

  const listener = await startOpenReceiveNotificationListener({ service, host });
  notifier.handler({ type: "payment_received" });
  await until(() => passes.length === 1, { label: "the first reconcile pass" });
  // A burst while a pass runs queues at most one follow-up pass.
  notifier.handler({ type: "payment_received" });
  notifier.handler({ type: "payment_received" });
  notifier.handler({ type: "payment_received" });
  notifier.handler({ type: "payment_sent" }); // never wakes reconciliation
  release();
  await until(() => passes.length === 2, { label: "the coalesced follow-up pass" });
  // Drain scheduled work deterministically (no wall-clock dependence): any
  // wrongly-queued extra pass would have started by now.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passes.length, 2);

  await listener.stop();
  assert.equal(notifier.unsubscribed, 1);
  notifier.handler({ type: "payment_received" });
  // Drain scheduled work deterministically (no wall-clock dependence): any
  // wrongly-queued extra pass would have started by now.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passes.length, 2, "a stopped listener never wakes another pass");
});

test("notification listener routes reconcile failures to onError and keeps listening", async () => {
  const errors = [];
  const host = {
    payments: {
      listForOrder: async () => [],
      listReconcilableAttempts: async () => [
        { paymentHash: hash("b"), createdAt: 900, expiresAt: 1_600 },
      ],
      commitAttempt: async () => undefined,
      recordReconciliation: async () => undefined,
      claimReconcileGate: async () => true,
    },
    resolveCheckout: async () => ({ amount: { sats: 100 } }),
    onCheckoutCreated: async () => undefined,
    onPaid: async () => undefined,
  };
  const { service, notifier } = scriptedNotifierService(async () => {
    throw new Error("relay down");
  });
  const listener = await startOpenReceiveNotificationListener({
    service,
    host,
    onError: (error) => errors.push(error),
  });
  notifier.handler({ type: "payment_received" });
  await until(() => errors.length === 1, { label: "the first reconcile failure" });
  assert.match(errors[0].message, /relay down/);
  notifier.handler({ type: "payment_received" });
  await until(() => errors.length === 2, { label: "the second reconcile failure" });
  await listener.stop();
});

test("notification listener defaults its error sink to the sanitized warn", async () => {
  const leaked = "nostr+walletconnect://abc?relay=wss://relay.test&secret=deadbeefcafe";
  const host = {
    payments: {
      listForOrder: async () => [],
      listReconcilableAttempts: async () => [
        { paymentHash: hash("b"), createdAt: 900, expiresAt: 1_600 },
      ],
      commitAttempt: async () => undefined,
      recordReconciliation: async () => undefined,
      claimReconcileGate: async () => true,
    },
    resolveCheckout: async () => ({ amount: { sats: 100 } }),
    onCheckoutCreated: async () => undefined,
    onPaid: async () => undefined,
  };
  const { service, notifier } = scriptedNotifierService(async () => {
    throw new Error(`relay rejected ${leaked}`);
  });
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    // No onError: this is the DEFAULT sink, the one a host never configures.
    const listener = await startOpenReceiveNotificationListener({ service, host });
    notifier.handler({ type: "payment_received" });
    await until(() => warnings.length >= 1, { label: "the default console.warn sink" });
    await listener.stop();
  } finally {
    console.warn = original;
  }
  const line = warnings.join("\n");
  assert.match(line, /notification listener failed/);
  assert.doesNotMatch(line, /nostr\+walletconnect/);
  assert.doesNotMatch(line, /deadbeefcafe/);
  assert.match(line, /\[REDACTED_NWC\]/);
});

test("a wake while another worker holds the gate never touches the wallet", async () => {
  const host = {
    payments: {
      listForOrder: async () => [],
      listReconcilableAttempts: async () => [
        { paymentHash: hash("b"), createdAt: 900, expiresAt: 1_600 },
      ],
      commitAttempt: async () => undefined,
      recordReconciliation: async () => undefined,
      // Another worker (web opportunistic or a sibling instance) just scanned.
      claimReconcileGate: async () => false,
    },
    resolveCheckout: async () => ({ amount: { sats: 100 } }),
    onCheckoutCreated: async () => undefined,
    onPaid: async () => undefined,
  };
  const { service, notifier } = scriptedNotifierService(async () => {
    throw new Error("a gate_busy wake must not scan the wallet");
  });
  const listener = await startOpenReceiveNotificationListener({ service, host });
  notifier.handler({ type: "payment_received" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifier.reconcileCalls, 0);
  await listener.stop();
});

test("notification listener refuses a repository without the durable scan gate", async () => {
  const { service } = scriptedNotifierService(async () => []);
  await assert.rejects(
    startOpenReceiveNotificationListener({
      service,
      host: {
        payments: {
          listForOrder: async () => [],
          listReconcilableAttempts: async () => [],
          commitAttempt: async () => undefined,
          recordReconciliation: async () => undefined,
        },
        resolveCheckout: async () => ({ amount: { sats: 100 } }),
        onCheckoutCreated: async () => undefined,
        onPaid: async () => undefined,
      },
    }),
    /claimReconcileGate/,
  );
});

test("notification listener rejects UNSUPPORTED_METHOD for a service without notifications", async () => {
  await assert.rejects(
    () =>
      startOpenReceiveNotificationListener({
        service: { reconcilePayments: async () => [] },
        host: {
          payments: {
            listForOrder: async () => [],
            listReconcilableAttempts: async () => [],
            commitAttempt: async () => undefined,
            recordReconciliation: async () => undefined,
          },
          resolveCheckout: async () => ({ amount: { sats: 100 } }),
          onCheckoutCreated: async () => undefined,
          onPaid: async () => undefined,
        },
      }),
    (error) => error instanceof OpenReceiveError && error.code === "UNSUPPORTED_METHOD",
  );
});
