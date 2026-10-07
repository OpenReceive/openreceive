import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import knexFactory from "knex";
import pg from "pg";
import { DataSource } from "typeorm";
import {
  createHost,
  createSqlPayments,
  knexDb,
  paymentsSchemaSql,
  prismaDb,
  typeOrmDb,
} from "../../packages/js/http/src/index.ts";
import { resolveSqlAdapter } from "../../packages/js/http/src/sql-adapters.ts";
import { PrismaClient } from "./pooler/generated/client.ts";

// Serverless hosts reach PostgreSQL through a transaction pooler: Supabase's
// port 6543, Neon's -pooler hosts, PgBouncer. Consecutive transactions from one
// client land on different server connections, so session state (session
// advisory locks, SET, named prepared statements) is not available. This lane
// runs the payments contract through tests/orms/pooler/pgbouncer.ini, which is
// transaction pooling with server-side prepared statements off.
const url = process.env.OPENRECEIVE_TEST_POOLER_URL;
const skip =
  !url &&
  "Set OPENRECEIVE_TEST_POOLER_URL to PgBouncer from tests/orms/pooler/ for pooler coverage";

test("the pooler under test runs transaction pooling without prepared statements", {
  skip,
}, async () => {
  const admin = new pg.Client(url.replace(/\/[^/?]+(\?|$)/, "/pgbouncer$1"));
  await admin.connect();
  try {
    const config = Object.fromEntries(
      (await admin.query("SHOW CONFIG")).rows.map((row) => [row.key, row.value]),
    );
    assert.equal(config.pool_mode, "transaction");
    assert.equal(config.max_prepared_statements, "0");
  } finally {
    await admin.end();
  }
});

function attempts() {
  let count = 0;
  return (reference, expiresAt = 1_800) => {
    count += 1;
    const paymentHash = count.toString(16).padStart(64, "0");
    return {
      reference,
      paymentHash,
      checkout: {
        reference,
        paymentHash,
        bolt11: `lnbc-${count}`,
        amountMsats: 1_000,
        createdAt: 900,
        expiresAt,
        fiatQuote: null,
      },
    };
  };
}

async function exercise(adapter) {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const tableName = `pool_payments_${suffix}`;
  const metaTableName = `pool_meta_${suffix}`;
  const orders = `pool_orders_${suffix}`;
  // Setup and teardown use a plain client: the schema is several statements,
  // which some ORMs' raw-query calls refuse.
  const setup = async (sql) => {
    const client = new pg.Client(url);
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  await setup(paymentsSchemaSql("postgres", tableName, metaTableName));
  await setup(`CREATE TABLE ${orders} (reference text PRIMARY KEY, pid integer)`);
  try {
    const payments = createSqlPayments(adapter, { tableName, metaTableName, clock: () => 1_000 });

    // Retries race on twenty references at once. The per-reference advisory
    // lock is transaction-scoped, so it holds through the pooler: each
    // reference keeps exactly one of its two concurrent new attempts.
    const attempt = attempts();
    const references = Array.from({ length: 20 }, (_, n) => `order-${n}`);
    const outcomes = await Promise.all(
      references.map(async (reference) => {
        await payments.commitAttempt(attempt(reference, 1_040));
        const racers = [attempt(reference), attempt(reference)].map((x) =>
          payments.commitAttempt(x),
        );
        return (await Promise.allSettled(racers)).filter((x) => x.status === "fulfilled").length;
      }),
    );
    assert.deepEqual(
      outcomes,
      references.map(() => 1),
    );

    // Settlement runs in one transaction, so one server connection, even
    // through the pooler. A failed fulfillment rolls back the host write and
    // the settled row together; replays and a sibling settle it exactly once.
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
    const [settle, sibling] = await payments.listForReference("order-0");
    const event = { paymentHash: settle.paymentHash, paidAt: 1_010 };
    await assert.rejects(host.onPaid(event), /rollback host and ledger/);
    assert.deepEqual(await adapter.query(`SELECT * FROM ${orders}`), []);
    assert.ok((await payments.listForReference("order-0")).every((x) => x.status !== "settled"));
    fail = false;
    await Promise.all([
      host.onPaid(event),
      host.onPaid(event),
      host.onPaid({ ...event, paymentHash: sibling.paymentHash }),
    ]);
    assert.equal((await adapter.query(`SELECT * FROM ${orders}`)).length, 1);
    assert.equal((await payments.findByPaymentHash(event.paymentHash)).status, "settled");

    // The reconcile gate is a compare-and-set on a row, not a session lock:
    // ten simultaneous claims through the pooler yield exactly one token.
    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        payments.claimReconcileGate({ now: 2_000, intervalSeconds: 3 }),
      ),
    );
    assert.equal(claims.filter((claim) => claim?.token).length, 1);
    assert.equal(await payments.claimReconcileGate({ now: 2_001, intervalSeconds: 3 }), null);
  } finally {
    await setup(`DROP TABLE IF EXISTS ${orders}, ${tableName}, ${metaTableName}`);
  }
}

test("pg Pool through a transaction pooler", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  try {
    await exercise(resolveSqlAdapter(pool));
  } finally {
    await pool.end();
  }
});

test("Knex (pg) through a transaction pooler", { skip }, async () => {
  const knex = knexFactory({ client: "pg", connection: url, pool: { min: 0, max: 10 } });
  try {
    await exercise(knexDb(knex, "postgres"));
  } finally {
    await knex.destroy();
  }
});

test("Prisma (@prisma/adapter-pg) through a transaction pooler", { skip }, async () => {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10 }) });
  try {
    await exercise(prismaDb(prisma, "postgres"));
  } finally {
    await prisma.$disconnect();
  }
});

test("TypeORM (postgres) through a transaction pooler", { skip }, async () => {
  const dataSource = new DataSource({ type: "postgres", url, poolSize: 10 });
  await dataSource.initialize();
  try {
    await exercise(typeOrmDb(dataSource, "postgres"));
  } finally {
    await dataSource.destroy();
  }
});
