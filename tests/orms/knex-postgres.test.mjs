import assert from "node:assert/strict";
import test from "node:test";
import knexFactory from "knex";
import {
  createHost,
  createSqlPayments,
  knexDb,
  paymentsSchemaSql,
} from "../../packages/js/http/src/index.ts";

const connection = process.env.OPENRECEIVE_TEST_POSTGRES_URL;
test("PostgreSQL Knex preserves native SQL and atomic custom-repository fulfillment", {
  skip: !connection && "Set OPENRECEIVE_TEST_POSTGRES_URL for real PostgreSQL coverage",
}, async () => {
  const knex = knexFactory({ client: "pg", connection, pool: { min: 0, max: 5 } });
  const adapter = knexDb(knex, "postgres");
  const suffix = `${process.pid}_${Date.now()}`;
  const tableName = `safety_payments_${suffix}`;
  const metaTableName = `safety_meta_${suffix}`;
  const orders = `safety_orders_${suffix}`;
  try {
    await adapter.query(paymentsSchemaSql("postgres", tableName, metaTableName));
    await adapter.query(`CREATE TABLE ${orders} (reference text PRIMARY KEY, pid integer)`);
    const sql = `SELECT $2::text AS second, $1::text AS first, $2::text AS repeated,
      '$1 ?' AS literal, $$? $2$$ AS quoted,
      '{"x":1}'::jsonb ? 'x' AS has_key,
      '{"x":1}'::jsonb ?| array['x','y'] AS any_key,
      '{"x":1}'::jsonb ?& array['x'] AS all_keys /* $1 ? */`;
    assert.deepEqual(await adapter.query(sql, ["one", "two"]), [
      {
        second: "two",
        first: "one",
        repeated: "two",
        literal: "$1 ?",
        quoted: "? $2",
        has_key: true,
        any_key: true,
        all_keys: true,
      },
    ]);
    const payments = createSqlPayments(adapter, { tableName, metaTableName, clock: () => 1000 });
    const attempt = (n, expiresAt = 1800) => ({
      reference: "order",
      paymentHash: n.repeat(64),
      checkout: {
        reference: "order",
        paymentHash: n.repeat(64),
        bolt11: `lnbc-${n}`,
        amountMsats: 1000,
        createdAt: 900,
        expiresAt,
        fiatQuote: null,
      },
    });
    await payments.commitAttempt(attempt("a", 1040));
    const creates = await Promise.allSettled([
      payments.commitAttempt(attempt("b")),
      payments.commitAttempt(attempt("c")),
    ]);
    assert.equal(creates.filter((x) => x.status === "fulfilled").length, 1);
    let fail = true;
    const host = createHost({
      payments,
      amountFor: () => ({ sats: 1 }),
      onPaid: async ({ reference, transaction }) => {
        const [before] = await transaction.query("SELECT pg_backend_pid() AS pid");
        const [written] = await transaction.query(
          `INSERT INTO ${orders} VALUES ($1, pg_backend_pid()) RETURNING pid`,
          [reference],
        );
        assert.equal(before.pid, written.pid);
        if (fail) throw new Error("rollback host and ledger");
      },
    });
    const event = { paymentHash: "a".repeat(64), paidAt: 1010 };
    await assert.rejects(host.onPaid(event), /rollback host and ledger/);
    assert.deepEqual(await adapter.query(`SELECT * FROM ${orders}`), []);
    assert.ok((await payments.listForReference("order")).every((x) => x.status === "pending"));
    fail = false;
    const sibling = (await payments.listForReference("order")).find(
      (x) => x.paymentHash !== event.paymentHash,
    );
    await Promise.all([
      host.onPaid(event),
      host.onPaid(event),
      host.onPaid({ ...event, paymentHash: sibling.paymentHash }),
    ]);
    assert.equal((await adapter.query(`SELECT * FROM ${orders}`)).length, 1);
    assert.ok((await payments.listForReference("order")).every((x) => x.status === "settled"));
    assert.ok((await payments.claimReconcileGate({ now: 1000, intervalSeconds: 2 }))?.token);
    assert.equal(await payments.claimReconcileGate({ now: 1001, intervalSeconds: 2 }), null);
    assert.equal(knex.client.pool.numUsed(), 0, "all acquired connections released");
  } finally {
    await adapter.query(`DROP TABLE IF EXISTS ${orders}, ${tableName}, ${metaTableName}`);
    await knex.destroy();
  }
});
