import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { hash, memoryPaymentsDb } from "./helpers/factories.mjs";
import {
  OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS,
  OPENRECEIVE_PAYMENTS_SCHEMA_VERSION,
  OPENRECEIVE_RECONCILE_BATCH_SIZE,
  createOpenReceiveHost,
  createOpenReceiveSqlPayments,
  openReceivePaymentsSchemaSql,
  reconcileOpenReceivePayments,
} from "../packages/js/http/src/index.ts";
import { resolveSqlAdapter } from "../packages/js/http/src/sql-adapters.ts";
// Internal decision table: imported from the module directly (it is
// deliberately not on the public package surface).
import { reconciliationTransition } from "../packages/js/http/src/payment-repository.ts";

function swapData(asset, expiresAt = 1_600) {
  return {
    version: 1,
    providerOrder: {
      provider: "test",
      provider_order_id: `provider-${asset}`,
      provider_token: "server-only",
      pay_in_asset: asset,
      deposit_address: "T-address",
      deposit_amount: "1",
      expires_at: expiresAt,
      state: "awaiting_deposit",
    },
  };
}

function checkoutInput(
  orderId,
  character,
  { createdAt = 900, expiresAt = 1_600, swapData, clientIp } = {},
) {
  const paymentHash = hash(character);
  return {
    orderId,
    paymentHash,
    checkout: {
      orderId,
      paymentHash,
      bolt11: `lnbc-${character}`,
      amountMsats: 1_000,
      createdAt,
      expiresAt,
      fiatQuote: null,
    },
    ...(swapData === undefined ? {} : { swapData }),
    ...(clientIp === undefined ? {} : { clientIp }),
  };
}

function sqliteRepository({ now = () => 1_000 } = {}) {
  const db = memoryPaymentsDb();
  return { db, payments: createOpenReceiveSqlPayments(db, { clock: now }) };
}

test("commitAttempt is idempotent for a repeated payment hash", async () => {
  const { payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-1", "a"));
  await payments.commitAttempt(checkoutInput("order-1", "a"));
  const rows = await payments.listForOrder("order-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paymentHash, hash("a"));
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].statusReason, null);
  assert.equal(rows[0].paidAt, null);
  assert.deepEqual(rows[0].checkout, checkoutInput("order-1", "a").checkout);
});

test("commitAttempt rejects a new attempt once the order settled", async () => {
  const { payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-1", "a"));
  await payments.markPaidOnce({ paymentHash: hash("a"), paidAt: 990 }, async () => undefined);
  await assert.rejects(
    payments.commitAttempt(checkoutInput("order-1", "b")),
    (error) => error.status === 409 && /already paid/.test(error.message),
  );
  assert.equal((await payments.listForOrder("order-1")).length, 1);
});

test("commitAttempt conflicts on a reusable same-rail attempt but keeps other rails live", async () => {
  const { payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-1", "a")); // Lightning, 600s of life left
  await assert.rejects(
    payments.commitAttempt(checkoutInput("order-1", "b")),
    (error) => error.status === 409 && /already in progress for this order/.test(error.message),
  );

  // A swap on another asset may go live while Lightning stays live.
  await payments.commitAttempt(checkoutInput("order-1", "c", { swapData: swapData("USDT_TRON") }));
  await assert.rejects(
    payments.commitAttempt(checkoutInput("order-1", "d", { swapData: swapData("USDT_TRON") })),
    /already in progress for this order/,
  );
  await payments.commitAttempt(checkoutInput("order-1", "e", { swapData: swapData("USDC_SOL") }));

  const statuses = new Map(
    (await payments.listForOrder("order-1")).map((row) => [row.paymentHash, row.status]),
  );
  assert.deepEqual(
    statuses,
    new Map([
      [hash("a"), "pending"],
      [hash("c"), "pending"],
      [hash("e"), "pending"],
    ]),
  );
});

test("commitAttempt supersedes a near-expiry same-rail attempt without closing it", async () => {
  const { payments } = sqliteRepository(); // clock 1000; reuse buffer 60
  await payments.commitAttempt(checkoutInput("order-1", "a", { expiresAt: 1_040 }));
  await payments.commitAttempt(checkoutInput("order-1", "b", { expiresAt: 1_600 }));

  const rows = await payments.listForOrder("order-1");
  const byHash = new Map(rows.map((row) => [row.paymentHash, row]));
  // The superseded invoice is still payable until it expires wallet-side, so
  // it stays pending and keeps its place in the scan set — closing it on the
  // local clock would make a real payment to it permanently unmatchable.
  assert.equal(byHash.get(hash("a")).status, "pending");
  assert.equal(byHash.get(hash("a")).statusReason, "superseded");
  assert.equal(byHash.get(hash("b")).status, "pending");

  const reconcilable = (await payments.listReconcilableAttempts()).map((row) => row.paymentHash);
  assert.ok(
    reconcilable.includes(hash("a")),
    "a superseded attempt must stay reconcilable so late funds still settle",
  );
});

test("a superseded attempt still settles when the payer pays the old invoice", async () => {
  const { payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-1", "a", { expiresAt: 1_040 }));
  await payments.commitAttempt(checkoutInput("order-1", "b", { expiresAt: 1_600 }));

  const fulfilled = [];
  await payments.markPaidOnce({ paymentHash: hash("a"), paidAt: 1_030 }, async (settlement) => {
    fulfilled.push(settlement.paymentHash);
  });

  const byHash = new Map(
    (await payments.listForOrder("order-1")).map((row) => [row.paymentHash, row]),
  );
  assert.equal(byHash.get(hash("a")).status, "settled");
  assert.deepEqual(fulfilled, [hash("a")]);
});

test("a superseded attempt is neither reused nor superseded a second time", async () => {
  const { payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-1", "a", { expiresAt: 1_040 }));
  await payments.commitAttempt(checkoutInput("order-1", "b", { expiresAt: 1_600 }));
  // 'b' is live and same-rail, so a third same-rail attempt still conflicts —
  // the superseded 'a' must not be what decides this.
  await assert.rejects(
    () => payments.commitAttempt(checkoutInput("order-1", "c", { expiresAt: 1_700 })),
    /already in progress for this order/,
  );

  const byHash = new Map(
    (await payments.listForOrder("order-1")).map((row) => [row.paymentHash, row]),
  );
  assert.equal(byHash.get(hash("a")).statusReason, "superseded");
  assert.equal(byHash.get(hash("a")).status, "pending");
});

test("markPaidOnce settles write-once and fulfills only the order's first settled attempt", async () => {
  const { payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-1", "a"));
  await payments.commitAttempt(checkoutInput("order-1", "b", { swapData: swapData("USDT_TRON") }));

  const fulfilled = [];
  await payments.markPaidOnce({ paymentHash: hash("a"), paidAt: 990 }, async (settlement) => {
    // The fulfill hook sees the already-settled row inside its own transaction.
    const inTx = await settlement.query(
      "SELECT status FROM openreceive_payments WHERE payment_hash = ?",
      [settlement.paymentHash],
    );
    fulfilled.push({
      orderId: settlement.orderId,
      paymentHash: settlement.paymentHash,
      paidAt: settlement.paidAt,
      statusInTransaction: inTx[0].status,
    });
  });
  assert.deepEqual(fulfilled, [
    {
      orderId: "order-1",
      paymentHash: hash("a"),
      paidAt: 990,
      statusInTransaction: "settled",
    },
  ]);

  // Replaying the same settlement never fulfills twice.
  await payments.markPaidOnce({ paymentHash: hash("a"), paidAt: 990 }, async () => {
    assert.fail("a settled attempt must not fulfill again");
  });

  // A sibling attempt settling later is recorded but never fulfills.
  await payments.markPaidOnce({ paymentHash: hash("b"), paidAt: 995 }, async () => {
    assert.fail("a duplicate settlement must not fulfill");
  });

  const byHash = new Map(
    (await payments.listForOrder("order-1")).map((row) => [row.paymentHash, row]),
  );
  assert.equal(byHash.get(hash("a")).status, "settled");
  assert.equal(byHash.get(hash("a")).statusReason, null);
  assert.equal(byHash.get(hash("a")).paidAt, 990);
  assert.equal(byHash.get(hash("b")).status, "settled");
  assert.equal(byHash.get(hash("b")).statusReason, "duplicate_settlement");
  assert.equal(byHash.get(hash("b")).paidAt, 995);

  // An unknown hash is a no-op, not an error.
  await payments.markPaidOnce({ paymentHash: hash("f"), paidAt: 999 }, async () => {
    assert.fail("unknown payment hashes never fulfill");
  });
});

test("markPaidOnce rolls back with the fulfill callback so settlement is replay-safe", async () => {
  const { payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-1", "a"));

  await assert.rejects(
    payments.markPaidOnce({ paymentHash: hash("a"), paidAt: 990 }, async () => {
      throw new Error("host order update failed");
    }),
    /host order update failed/,
  );
  assert.equal((await payments.listForOrder("order-1"))[0].status, "pending");

  const fulfilled = [];
  await payments.markPaidOnce({ paymentHash: hash("a"), paidAt: 990 }, async (settlement) => {
    fulfilled.push(settlement.paymentHash);
  });
  assert.deepEqual(fulfilled, [hash("a")]);
  assert.equal((await payments.listForOrder("order-1"))[0].status, "settled");
});

test("recordReconciliation applies only while pending and never overwrites settled", async () => {
  const { payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-1", "a"));
  await payments.commitAttempt(checkoutInput("order-2", "b"));
  await payments.markPaidOnce({ paymentHash: hash("b"), paidAt: 990 }, async () => undefined);

  await payments.recordReconciliation({
    paymentHash: hash("a"),
    status: "expired",
    observedAt: 2_900,
    reason: "not_found_after_expiry",
  });
  const transitioned = (await payments.listForOrder("order-1"))[0];
  assert.equal(transitioned.status, "expired");
  assert.equal(transitioned.statusReason, "not_found_after_expiry");

  // A second transition finds no pending row: the first terminal state sticks.
  await payments.recordReconciliation({
    paymentHash: hash("a"),
    status: "failed",
    observedAt: 3_000,
    reason: "wallet_reported_failed",
  });
  assert.equal((await payments.listForOrder("order-1"))[0].status, "expired");

  // A settled row is never overwritten by a reconciliation transition.
  await payments.recordReconciliation({
    paymentHash: hash("b"),
    status: "expired",
    observedAt: 3_000,
    reason: "not_found_after_expiry",
  });
  const settled = (await payments.listForOrder("order-2"))[0];
  assert.equal(settled.status, "settled");
  assert.equal(settled.statusReason, null);
  assert.equal(settled.paidAt, 990);
});

test("listReconcilableAttempts returns pending rows only, with swap provider expiry", async () => {
  const { payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-1", "a", { createdAt: 800 }));
  await payments.commitAttempt(checkoutInput("order-2", "b"));
  await payments.commitAttempt(checkoutInput("order-3", "c"));
  await payments.commitAttempt(
    checkoutInput("order-4", "d", { createdAt: 850, swapData: swapData("USDT_TRON", 1_700) }),
  );
  await payments.markPaidOnce({ paymentHash: hash("b"), paidAt: 990 }, async () => undefined);
  await payments.recordReconciliation({
    paymentHash: hash("c"),
    status: "failed",
    observedAt: 1_000,
    reason: "wallet_reported_failed",
  });

  const attempts = [...(await payments.listReconcilableAttempts())].sort((left, right) =>
    left.paymentHash.localeCompare(right.paymentHash),
  );
  assert.deepEqual(attempts, [
    { paymentHash: hash("a"), createdAt: 800, expiresAt: 1_600 },
    { paymentHash: hash("d"), createdAt: 850, expiresAt: 1_700 },
  ]);
});

test("reconciliationTransition matches every attempt-reconciliation spec vector", () => {
  const spec = JSON.parse(readFileSync("spec/test-vectors/attempt-reconciliation.json", "utf8"));
  assert.equal(spec.expiry_grace_seconds, OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS);
  assert.ok(spec.vectors.length >= 10, "the vector file must not silently shrink");
  for (const vector of spec.vectors) {
    const attempt = {
      paymentHash: hash("a"),
      createdAt: 0,
      expiresAt: vector.attempt.expires_at,
    };
    const actual = reconciliationTransition(
      attempt,
      vector.status,
      vector.observed_at,
      vector.transaction_state,
    );
    if (vector.expected === null) {
      assert.equal(actual, null, vector.name);
    } else {
      assert.deepEqual(
        actual,
        {
          paymentHash: hash("a"),
          status: vector.expected.status,
          observedAt: vector.observed_at,
          reason: vector.expected.reason,
        },
        vector.name,
      );
    }
  }
});

test("one reconciliation pass settles, closes, and flags rows so terminal rows leave the scan set", async () => {
  const now = 1_000;
  const db = memoryPaymentsDb();
  const settled = [];
  const host = createOpenReceiveHost({
    db,
    clock: () => now,
    loadOrder: async (orderId) => ({ orderId }),
    amountForOrder: () => ({ sats: 1 }),
    onPaid: async (settlement) => {
      settled.push({
        orderId: settlement.orderId,
        paymentHash: settlement.paymentHash,
        paidAt: settlement.paidAt,
      });
    },
  });
  await host.onCheckoutCreated(checkoutInput("order-a", "a", { expiresAt: 1_600 }));
  await host.onCheckoutCreated(checkoutInput("order-b", "b", { expiresAt: 1_600 }));
  // Expired long ago: 1000 >= 50 + 900 grace, so a not_found scan closes it.
  await host.onCheckoutCreated(checkoutInput("order-c", "c", { createdAt: 40, expiresAt: 50 }));
  await host.onCheckoutCreated(checkoutInput("order-d", "d", { expiresAt: 1_600 }));

  const scanned = [];
  const service = {
    async reconcilePayments(input) {
      scanned.push(input);
      return [
        { paymentHash: hash("a"), status: "settled", paidAt: 990 },
        { paymentHash: hash("b"), status: "failed" },
        { paymentHash: hash("c"), status: "not_found" },
        { paymentHash: hash("d"), status: "pending" },
      ];
    },
  };

  await reconcileOpenReceivePayments({ service, host, clock: () => now });

  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].attempts.length, 4);
  assert.deepEqual(settled, [{ orderId: "order-a", paymentHash: hash("a"), paidAt: 990 }]);

  const status = async (orderId) => (await host.payments.listForOrder(orderId))[0];
  assert.equal((await status("order-a")).status, "settled");
  assert.equal((await status("order-b")).status, "failed");
  assert.equal((await status("order-b")).statusReason, "wallet_reported_failed");
  assert.equal((await status("order-c")).status, "expired");
  assert.equal((await status("order-c")).statusReason, "not_found_after_expiry");
  assert.equal((await status("order-d")).status, "pending");

  // Terminal rows leave the scan set; only the still-pending attempt remains.
  assert.deepEqual(await host.payments.listReconcilableAttempts(), [
    { paymentHash: hash("d"), createdAt: 900, expiresAt: 1_600 },
  ]);

  // A second pass rescans only the pending attempt and never re-fulfills.
  await reconcileOpenReceivePayments({ service, host, clock: () => now });
  assert.deepEqual(scanned[1].attempts, [
    { paymentHash: hash("d"), createdAt: 900, expiresAt: 1_600 },
  ]);
  assert.equal(settled.length, 1);
});

test("reconciliation threads the wallet's explicit transaction state into the post-grace decision", async () => {
  // All three attempts expired at 50; with the 900-second grace, a scan at
  // 1_000 is past the closure threshold for every one of them.
  const now = 1_000;
  const db = memoryPaymentsDb();
  const host = createOpenReceiveHost({
    db,
    clock: () => now,
    loadOrder: async (orderId) => ({ orderId }),
    amountForOrder: () => ({ sats: 1 }),
    onPaid: async () => undefined,
  });
  await host.onCheckoutCreated(checkoutInput("order-e", "e", { createdAt: 40, expiresAt: 50 }));
  await host.onCheckoutCreated(checkoutInput("order-f", "f", { createdAt: 40, expiresAt: 50 }));
  await host.onCheckoutCreated(checkoutInput("order-g", "9", { createdAt: 40, expiresAt: 50 }));

  const service = {
    async reconcilePayments() {
      const details = (transaction) => ({ transaction, observed_at: now });
      return [
        // Explicit in-flight claims survive as operator-attention cases.
        { paymentHash: hash("e"), status: "pending", details: details({ state: "pending" }) },
        {
          paymentHash: hash("f"),
          status: "pending",
          details: details({ transaction_state: "accepted" }),
        },
        // A record with no state at all is an ordinary abandoned invoice.
        { paymentHash: hash("9"), status: "pending", details: details({}) },
      ];
    },
  };
  await reconcileOpenReceivePayments({ service, host, clock: () => now });

  const row = async (orderId) => (await host.payments.listForOrder(orderId))[0];
  assert.deepEqual(
    [(await row("order-e")).status, (await row("order-e")).statusReason],
    ["attention", "unsettled_after_expiry"],
  );
  assert.deepEqual(
    [(await row("order-f")).status, (await row("order-f")).statusReason],
    ["attention", "unsettled_after_expiry"],
  );
  assert.deepEqual(
    [(await row("order-g")).status, (await row("order-g")).statusReason],
    ["expired", "no_finality_after_expiry"],
  );
});

test("pg adapter converts placeholders and serializes commits behind the advisory lock", async () => {
  const poolQueries = [];
  const clientQueries = [];
  let released = 0;
  const client = {
    async query(sql, params) {
      clientQueries.push({ sql, params });
      return { rows: [] };
    },
    release() {
      released += 1;
    },
  };
  const pool = {
    async query(sql, params) {
      poolQueries.push({ sql, params });
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  };
  const payments = createOpenReceiveSqlPayments(pool, { clock: () => 1_000 });

  await payments.commitAttempt(checkoutInput("order-pg", "e"));

  // The whole commit runs on the pooled client, inside BEGIN/COMMIT; the only
  // pool query is the one-per-repository schema-version probe.
  assert.equal(poolQueries.length, 1);
  assert.match(poolQueries[0].sql, /SELECT value FROM openreceive_meta WHERE key = \$1/);
  assert.deepEqual(poolQueries[0].params, ["schema_version"]);
  assert.equal(released, 2);
  const sqls = clientQueries.map((entry) => entry.sql);
  assert.equal(sqls[0], "BEGIN");
  assert.equal(sqls[1], "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))");
  assert.deepEqual(clientQueries[1].params, ["order-pg", 8_210_223]);
  assert.equal(sqls.at(-1), "COMMIT");

  for (const { sql } of clientQueries) {
    assert.ok(!sql.includes("?"), `pg SQL must use $n placeholders: ${sql}`);
  }
  const select = clientQueries.find((entry) => entry.sql.startsWith("SELECT * FROM"));
  assert.match(select.sql, /WHERE order_id = \$1/);
  const insert = clientQueries.find((entry) => entry.sql.trimStart().startsWith("INSERT"));
  assert.match(
    insert.sql,
    /VALUES \(\$1, \$2, 'pending', NULL, \$3, \$4, \$5, \$6, \$7, \$8, \$9\)/,
  );
  assert.equal(insert.params.length, 9);
  assert.equal(insert.params[1], hash("e"));

  // Reads outside a transaction go straight to the pool.
  await payments.listReconcilableAttempts();
  assert.equal(poolQueries.length, 2, "the schema probe runs once per repository");
  assert.match(poolQueries[1].sql, /WHERE status = 'pending'/);
  assert.match(poolQueries[1].sql, /ORDER BY created_at ASC LIMIT \$1/);
  assert.deepEqual(poolQueries[1].params, [OPENRECEIVE_RECONCILE_BATCH_SIZE]);
});

test("host SQL inside the settlement transaction reaches a pg driver untouched", async () => {
  // The documented onPaid escape hatch: the host writes its own statement, in
  // its own dialect. Rewriting `?` would corrupt a JSON operator, a literal, or
  // a comment inside the one transaction that marks orders paid.
  const seen = [];
  const client = {
    async query(sql, params) {
      seen.push({ sql, params });
      if (sql.startsWith("SELECT order_id")) return { rows: [{ order_id: "order-json" }] };
      if (sql.startsWith("SELECT * FROM openreceive_payments")) {
        return {
          rows: [
            {
              order_id: "order-json",
              payment_hash: hash("a"),
              status: "pending",
              status_reason: null,
              paid_at: null,
              expires_at: 1_600,
              created_at: 900,
              updated_at: 900,
              checkout_data: JSON.stringify(checkoutInput("order-json", "a").checkout),
              swap_data: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async query() {
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  };
  const payments = createOpenReceiveSqlPayments(pool, { clock: () => 1_000 });

  const hostSql =
    "UPDATE orders SET note = 'paid? yes' WHERE data ? 'field' AND tags ?| ARRAY['a'] AND id = $1 -- why?";
  await payments.markPaidOnce({ paymentHash: hash("a"), paidAt: 990 }, async (settlement) => {
    await settlement.query(hostSql, ["order-json"]);
  });

  const hostStatement = seen.find((entry) => entry.sql.startsWith("UPDATE orders"));
  assert.equal(hostStatement.sql, hostSql, "host SQL must not be rewritten");
  assert.deepEqual(hostStatement.params, ["order-json"]);
  // The library's own statements still arrive in postgres form.
  for (const { sql } of seen) {
    assert.ok(
      !sql.includes("?") || sql === hostSql,
      `library SQL must use $n placeholders: ${sql}`,
    );
  }

  // Same guarantee straight through the public transaction API.
  seen.length = 0;
  await resolveSqlAdapter(pool).transaction(async (tx) => {
    await tx.query(hostSql, ["order-json"]);
  });
  assert.deepEqual(
    seen.map((entry) => entry.sql),
    ["BEGIN", hostSql, "COMMIT"],
  );
});

test("sqlite adapter serializes concurrent commits instead of throwing", async () => {
  const { payments } = sqliteRepository();
  // Two different orders committing at once must both succeed (per-order
  // serialization, not a single-transaction guard that rejects overlap).
  await Promise.all([
    payments.commitAttempt(checkoutInput("order-conc-a", "a")),
    payments.commitAttempt(checkoutInput("order-conc-b", "b")),
  ]);
  assert.equal((await payments.listForOrder("order-conc-a")).length, 1);
  assert.equal((await payments.listForOrder("order-conc-b")).length, 1);

  // A read racing a commit queues behind it rather than failing.
  const [rows] = await Promise.all([
    payments.listForOrder("order-conc-c"),
    payments.commitAttempt(checkoutInput("order-conc-c", "c")),
  ]);
  assert.ok(Array.isArray(rows));
});

test("pg Client that is already connected commits on its own connection", async () => {
  const sqls = [];
  let connectCalls = 0;
  const client = {
    async query(sql) {
      sqls.push(sql);
      return { rows: [] };
    },
    async connect() {
      connectCalls += 1;
      throw new Error("Client has already been connected. You cannot reuse a client.");
    },
  };
  const payments = createOpenReceiveSqlPayments(client, { clock: () => 1_000 });
  await payments.commitAttempt(checkoutInput("order-pgc-1", "a"));
  await payments.commitAttempt(checkoutInput("order-pgc-2", "b"));
  assert.equal(connectCalls, 1, "connect() must be probed at most once");
  assert.equal(sqls.filter((sql) => sql === "BEGIN").length, 2);
  assert.equal(sqls.filter((sql) => sql === "COMMIT").length, 2);
});

test("pg Client that is not yet connected is connected exactly once", async () => {
  const sqls = [];
  let connectCalls = 0;
  const client = {
    async query(sql) {
      sqls.push(sql);
      return { rows: [] };
    },
    async connect() {
      connectCalls += 1;
      // pg.Client.connect() resolves undefined once the socket is open.
      return undefined;
    },
  };
  const payments = createOpenReceiveSqlPayments(client, { clock: () => 1_000 });
  await payments.commitAttempt(checkoutInput("order-pgu-1", "a"));
  await payments.commitAttempt(checkoutInput("order-pgu-2", "b"));
  assert.equal(connectCalls, 1);
  assert.equal(sqls.filter((sql) => sql === "COMMIT").length, 2);
});

test("query-only pg handles serialize concurrent transactions in-process", async () => {
  const sqls = [];
  const db = {
    async query(sql) {
      sqls.push(sql);
      await new Promise((resolve) => setImmediate(resolve));
      return { rows: [] };
    },
  };
  const payments = createOpenReceiveSqlPayments(db, { clock: () => 1_000 });
  await Promise.all([
    payments.commitAttempt(checkoutInput("order-q-1", "a")),
    payments.commitAttempt(checkoutInput("order-q-2", "b")),
  ]);
  const beginIndexes = sqls.flatMap((sql, index) => (sql === "BEGIN" ? [index] : []));
  const commitIndexes = sqls.flatMap((sql, index) => (sql === "COMMIT" ? [index] : []));
  assert.equal(beginIndexes.length, 2);
  assert.ok(
    commitIndexes[0] < beginIndexes[1],
    "the second transaction must not BEGIN before the first COMMITs",
  );
});

test("the schema enforces the status and payment-hash invariants at the database", () => {
  const { db } = sqliteRepository();
  const insert = (paymentHash, status) =>
    db
      .prepare(
        `INSERT INTO openreceive_payments
           (order_id, payment_hash, status, expires_at, created_at, updated_at, inserted_at, checkout_data)
         VALUES (?, ?, ?, 1600, 900, 900, 900, '{}')`,
      )
      .run("order-check", paymentHash, status);

  insert(hash("a"), "pending");
  assert.throws(() => insert(hash("b"), "paid"), /CHECK|constraint/i);
  assert.throws(() => insert("z".repeat(64), "pending"), /CHECK|constraint/i);
  assert.throws(() => insert("A".repeat(64), "pending"), /CHECK|constraint/i);
  assert.throws(() => insert(hash("c").slice(0, 63), "pending"), /CHECK|constraint/i);
});

test("the schema records its version and keeps generated index names inside 63 bytes", () => {
  const { db } = sqliteRepository();
  const version = db
    .prepare("SELECT value FROM openreceive_meta WHERE key = 'schema_version'")
    .get();
  assert.equal(version.value, String(OPENRECEIVE_PAYMENTS_SCHEMA_VERSION));

  // A long custom table name must not produce an identifier postgres would
  // truncate (silently colliding two indexes onto one name).
  const longTable = `openreceive_payments_${"x".repeat(45)}`;
  const sql = openReceivePaymentsSchemaSql("postgres", longTable);
  const indexNames = [...sql.matchAll(/CREATE INDEX IF NOT EXISTS (\S+)/g)].map(
    (match) => match[1],
  );
  assert.equal(indexNames.length, 3);
  assert.equal(new Set(indexNames).size, 3);
  for (const name of indexNames) {
    assert.ok(Buffer.byteLength(name, "utf8") <= 63, `${name} exceeds the identifier limit`);
  }
  // Default table names are short enough to keep their readable index names.
  assert.match(openReceivePaymentsSchemaSql("postgres"), /openreceive_payments_order_created_idx/);
});

test("a repository refuses to serve a database written by a newer library", async () => {
  const { db, payments } = sqliteRepository();
  // The version this library installed serves normally.
  assert.deepEqual(await payments.listReconcilableAttempts(), []);

  db.prepare("UPDATE openreceive_meta SET value = ? WHERE key = 'schema_version'").run(
    String(OPENRECEIVE_PAYMENTS_SCHEMA_VERSION + 1),
  );
  const newer = createOpenReceiveSqlPayments(db, { clock: () => 1_000 });
  await assert.rejects(newer.listReconcilableAttempts(), /newer than this library/);
  await assert.rejects(newer.commitAttempt(checkoutInput("order-newer", "a")), /newer than this/);

  // No marker at all (a migration template that cannot seed rows) is treated
  // as unversioned, never as a refusal.
  db.prepare("DELETE FROM openreceive_meta WHERE key = 'schema_version'").run();
  const unversioned = createOpenReceiveSqlPayments(db, { clock: () => 1_000 });
  assert.deepEqual(await unversioned.listReconcilableAttempts(), []);
});

test("listReconcilableAttempts returns an oldest-first batch, not the whole backlog", async () => {
  const { db, payments } = sqliteRepository();
  const insert = db.prepare(
    `INSERT INTO openreceive_payments
       (order_id, payment_hash, status, expires_at, created_at, updated_at, inserted_at, checkout_data)
     VALUES (?, ?, 'pending', 1600, ?, 900, 900, '{}')`,
  );
  const total = OPENRECEIVE_RECONCILE_BATCH_SIZE + 5;
  for (let index = 0; index < total; index += 1) {
    insert.run(`order-${index}`, index.toString(16).padStart(64, "0"), 1_000 - index);
  }
  const attempts = await payments.listReconcilableAttempts();
  assert.equal(attempts.length, OPENRECEIVE_RECONCILE_BATCH_SIZE);
  // Oldest first: the rows nearest their closure deadline are always covered.
  assert.equal(attempts[0].createdAt, 1_000 - (total - 1));
  assert.ok(
    attempts.every(
      (attempt, index) => index === 0 || attempt.createdAt >= attempts[index - 1].createdAt,
    ),
  );
});

test("a corrupt JSON column names the row instead of throwing a bare SyntaxError", async () => {
  const { db, payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-corrupt", "a"));
  db.prepare("UPDATE openreceive_payments SET checkout_data = ? WHERE payment_hash = ?").run(
    "{not json",
    hash("a"),
  );
  await assert.rejects(payments.listForOrder("order-corrupt"), (error) => {
    assert.match(error.message, /checkout_data/);
    assert.match(error.message, new RegExp(hash("a")));
    return true;
  });
});

test("a gate claim stamped in the future is stale, not fresh", async () => {
  const { db, payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-gate", "a"));
  assert.equal(await payments.claimReconcileGate({ now: 10_000, intervalSeconds: 2 }), true);
  assert.equal(await payments.claimReconcileGate({ now: 10_001, intervalSeconds: 2 }), false);

  // The host clock steps back an hour: without a negative-age clamp the claim
  // would read as "just written" and freeze the gate until time caught up.
  db.prepare("UPDATE openreceive_meta SET value = ? WHERE key = 'transaction_scan_gate'").run(
    JSON.stringify({ claimed_at: 10_000, token: "other-worker" }),
  );
  assert.equal(await payments.claimReconcileGate({ now: 6_400, intervalSeconds: 2 }), true);
  // A claim only slightly ahead is ordinary skew between workers, still fresh.
  db.prepare("UPDATE openreceive_meta SET value = ? WHERE key = 'transaction_scan_gate'").run(
    JSON.stringify({ claimed_at: 6_410, token: "other-worker" }),
  );
  assert.equal(await payments.claimReconcileGate({ now: 6_400, intervalSeconds: 2 }), false);
});

test("recordSettlement claims the order's first settlement exactly once", async () => {
  const { payments } = sqliteRepository();
  await payments.commitAttempt(checkoutInput("order-1", "a"));
  await payments.commitAttempt(checkoutInput("order-1", "b", { swapData: swapData("USDT_TRON") }));

  assert.equal(await payments.recordSettlement({ paymentHash: hash("a"), paidAt: 990 }), true);
  assert.equal(
    await payments.recordSettlement({ paymentHash: hash("a"), paidAt: 990 }),
    false,
    "a replayed settlement never wins the claim again",
  );
  assert.equal(
    await payments.recordSettlement({ paymentHash: hash("b"), paidAt: 995 }),
    false,
    "a sibling's genuine second payment is recorded but never fulfills",
  );
  assert.equal(await payments.recordSettlement({ paymentHash: hash("f"), paidAt: 999 }), false);

  const byHash = new Map(
    (await payments.listForOrder("order-1")).map((row) => [row.paymentHash, row]),
  );
  assert.equal(byHash.get(hash("a")).status, "settled");
  assert.equal(byHash.get(hash("a")).statusReason, null);
  assert.equal(byHash.get(hash("b")).status, "settled");
  assert.equal(byHash.get(hash("b")).statusReason, "duplicate_settlement");
});

test("the rate-limit window counts an immutable insert stamp, not a moving one", async () => {
  let now = 10_000;
  const { payments } = sqliteRepository({ now: () => now });
  await payments.commitAttempt(
    checkoutInput("order-old", "a", { expiresAt: 10_600, clientIp: "203.0.113.7" }),
  );
  // Inside the window it counts.
  assert.equal(await payments.countAttemptsFromIp("203.0.113.7", now - 3_600), 1);

  // An hour later that attempt is outside the budget window.
  now = 10_000 + 3_601;
  assert.equal(await payments.countAttemptsFromIp("203.0.113.7", now - 3_600), 0);

  // A later status transition touches the row. Counting on updated_at would
  // re-enter this old attempt into the current window and throttle a payer for
  // activity they did not cause; inserted_at never moves.
  await payments.recordReconciliation({
    paymentHash: hash("a"),
    status: "expired",
    reason: "no_finality_after_expiry",
    observedAt: now,
  });
  assert.equal(await payments.countAttemptsFromIp("203.0.113.7", now - 3_600), 0);
});
