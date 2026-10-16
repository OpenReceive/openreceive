import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import knexFactory from "knex";
import mysqlCallback from "mysql2";
import mysql from "mysql2/promise";
import { DataSource } from "typeorm";
import {
  createHost,
  createSqlPayments,
  knexDb,
  paymentsSchemaStatements,
  prismaDb,
  typeOrmDb,
} from "../../packages/js/http/src/index.ts";
import {
  finalizeScaffoldOptions,
  renderScaffoldPaymentsFiles,
} from "../../packages/js/node/src/cli.ts";
import { PrismaClient } from "./mysql/generated/client.ts";

// The MySQL and MariaDB lane behind `npm run test:orms`: the payments
// repository over a real server, through the built-in mysql2 binding (Pool,
// Connection, callback API) and through Knex, TypeORM and Prisma. Each server
// is skipped unless its URL is set; CI sets both.
const SERVERS = [
  ["MySQL", process.env.OPENRECEIVE_TEST_MYSQL_URL],
  ["MariaDB", process.env.OPENRECEIVE_TEST_MARIADB_URL],
];

let tableCount = 0;
function tableNames() {
  tableCount += 1;
  const suffix = `${process.pid}_${Date.now() % 100_000_000}_${tableCount}`;
  return {
    tableName: `or_pay_${suffix}`,
    metaTableName: `or_meta_${suffix}`,
    orders: `or_orders_${suffix}`,
  };
}

async function migrate(pool, { tableName, metaTableName }) {
  // Twice: the script must stay re-runnable.
  for (let run = 0; run < 2; run++) {
    for (const statement of paymentsSchemaStatements("mysql", tableName, metaTableName)) {
      await pool.query(statement);
    }
  }
}

async function drop(pool, names) {
  await pool.query(
    `DROP TABLE IF EXISTS ${[names.orders, names.tableName, names.metaTableName].join(", ")}`,
  );
}

const hashOf = (character) => character.repeat(64);

function attempt(reference, character, { expiresAt = 1_800, clientIp } = {}) {
  const paymentHash = hashOf(character);
  return {
    reference,
    paymentHash,
    checkout: {
      reference,
      paymentHash,
      bolt11: `lnbc-${character}`,
      amountMsats: 1_000,
      createdAt: 900,
      expiresAt,
      fiatQuote: null,
    },
    ...(clientIp === undefined ? {} : { clientIp }),
  };
}

/** The repository contract every MySQL binding must keep. */
async function exerciseContract(db, pool, names, { concurrent }) {
  const { tableName, metaTableName, orders } = names;
  const payments = createSqlPayments(db, { tableName, metaTableName, clock: () => 1_000 });

  // Commit: idempotent, then one live attempt per rail.
  await payments.commitAttempt(
    attempt("order", "a", { expiresAt: 1_040, clientIp: "203.0.113.9" }),
  );
  await payments.commitAttempt(
    attempt("order", "a", { expiresAt: 1_040, clientIp: "203.0.113.9" }),
  );
  const creates = await Promise.allSettled([
    payments.commitAttempt(attempt("order", "b")),
    payments.commitAttempt(attempt("order", "c")),
  ]);
  assert.equal(creates.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = creates.find((result) => result.status === "rejected");
  assert.match(String(rejected.reason?.message), /already in progress/);
  const winner = creates[0].status === "fulfilled" ? "b" : "c";
  assert.deepEqual(
    (await payments.listForReference("order")).map((row) => row.paymentHash).sort(),
    [hashOf("a"), hashOf(winner)].sort(),
  );
  assert.equal(await payments.countAttemptsFromIp("203.0.113.9", 0), 1);

  // References compare exactly, whatever the table's collation.
  await payments.commitAttempt(attempt("Case-A", "d"));
  await payments.commitAttempt(attempt("case-a", "e"));
  assert.deepEqual(
    (await payments.listForReference("Case-A")).map((row) => row.paymentHash),
    [hashOf("d")],
  );

  // Settlement: the host's guarded order claim, as the scaffold's MySQL wiring
  // guide writes it, runs on the payment's connection, and a failed
  // fulfillment rolls back the host write and the payment together.
  await pool.query(
    `CREATE TABLE ${orders} (id VARCHAR(255) PRIMARY KEY, state VARCHAR(32), paid_at BIGINT, conn BIGINT)`,
  );
  await pool.query(`INSERT INTO ${orders} (id, state) VALUES ('order', 'awaiting_payment')`);
  const claims = [];
  const claimOrder = async ({ reference, paidAt, query }) => {
    const [before] = await query("SELECT CONNECTION_ID() AS id");
    await query(
      `UPDATE ${orders} SET state = 'paid', paid_at = ?, conn = CONNECTION_ID() WHERE id = ? AND state = 'awaiting_payment'`,
      [paidAt, reference],
    );
    const [{ claimed }] = await query("SELECT ROW_COUNT() AS claimed");
    claims.push(Number(claimed));
    if (Number(claimed) === 0) return;
    const [written] = await query(`SELECT conn FROM ${orders} WHERE id = ?`, [reference]);
    assert.equal(
      Number(before.id),
      Number(written.conn),
      "host SQL runs on the payment's connection",
    );
  };
  let fail = true;
  const host = createHost({
    payments,
    amountFor: () => ({ sats: 1 }),
    onPaid: async ({ reference, paidAt, transaction }) => {
      await claimOrder({ reference, paidAt, query: transaction.query });
      if (fail) throw new Error("rollback host and ledger");
    },
  });
  await assert.rejects(host.onPaid({ paymentHash: hashOf("a"), paidAt: 1_010 }), /rollback host/);
  const [[rolledBack]] = await pool.query(`SELECT state FROM ${orders} WHERE id = 'order'`);
  assert.equal(rolledBack.state, "awaiting_payment");
  assert.ok((await payments.listForReference("order")).every((row) => row.status === "pending"));
  fail = false;

  // Two payments for one order settling at once fulfill it exactly once. The
  // first holds the reference lock inside its hook while the second waits for
  // it; the second must then see the first's committed settlement.
  if (concurrent) {
    let fulfilled = 0;
    const first = payments.markPaidOnce({ paymentHash: hashOf("a"), paidAt: 1_010 }, async (s) => {
      fulfilled += 1;
      await claimOrder(s);
      await sleep(400);
    });
    await sleep(100);
    const second = payments.markPaidOnce({ paymentHash: hashOf(winner), paidAt: 1_011 }, () => {
      fulfilled += 1;
    });
    assert.deepEqual(await Promise.all([first, second]), [true, false]);
    assert.equal(fulfilled, 1);
  } else {
    await Promise.all([
      host.onPaid({ paymentHash: hashOf("a"), paidAt: 1_010 }),
      host.onPaid({ paymentHash: hashOf("a"), paidAt: 1_010 }),
      host.onPaid({ paymentHash: hashOf(winner), paidAt: 1_011 }),
    ]);
  }
  assert.deepEqual(claims, [1, 1], "the rolled-back claim, then the committed one");
  const [[paid]] = await pool.query(`SELECT state, paid_at FROM ${orders} WHERE id = 'order'`);
  assert.deepEqual({ ...paid, paid_at: Number(paid.paid_at) }, { state: "paid", paid_at: 1_010 });
  // Any later claim of the same order updates nothing, and ROW_COUNT() says so.
  const session = await pool.getConnection();
  try {
    const query = async (sql, params) => (await session.query(sql, params))[0];
    await claimOrder({ reference: "order", paidAt: 1_020, query });
  } finally {
    session.release();
  }
  assert.equal(claims.at(-1), 0);
  const settled = await payments.listForReference("order");
  assert.ok(settled.every((row) => row.status === "settled"));
  assert.deepEqual(settled.map((row) => row.statusReason).sort(), ["duplicate_settlement", null]);
  assert.equal(settled.find((row) => row.paymentHash === hashOf("a")).paidAt, 1_010);
  await assert.rejects(payments.commitAttempt(attempt("order", "f")), /already paid/);

  // Reconciliation closes only pending rows; the repair report and requeue
  // read and write the meta table, whose `key` column MySQL reserves.
  await payments.recordReconciliation({
    paymentHash: hashOf("d"),
    status: "attention",
    reason: "unsettled_after_expiry",
    observedAt: 1_020,
  });
  await payments.recordReconciliation({
    paymentHash: hashOf("a"),
    status: "expired",
    reason: "not_found_after_expiry",
    observedAt: 1_020,
  });
  assert.equal((await payments.findByPaymentHash(hashOf("a"))).status, "settled");
  assert.deepEqual(
    (await payments.listReconcilableAttempts()).map((row) => row.paymentHash),
    [hashOf("e")],
  );
  const { candidates } = await payments.listRepairCandidates();
  assert.deepEqual(
    candidates.map((row) => [row.paymentHash, row.category]),
    [[hashOf("d"), "attention"]],
  );
  const requeue = {
    paymentHash: hashOf("d"),
    expectedStatus: "attention",
    expectedUpdatedAt: 1_020,
    reason: "reviewed",
  };
  assert.equal(await payments.requeueAttempt(requeue), true);
  assert.equal(await payments.requeueAttempt(requeue), false);
  assert.equal((await payments.findByPaymentHash(hashOf("d"))).status, "pending");

  // The durable reconcile gate's compare-and-set.
  assert.ok((await payments.claimReconcileGate({ now: 1_000, intervalSeconds: 60 }))?.token);
  assert.equal(await payments.claimReconcileGate({ now: 1_010, intervalSeconds: 60 }), null);
}

for (const [label, url] of SERVERS) {
  const skip = !url && `Set OPENRECEIVE_TEST_${label.toUpperCase()}_URL for real ${label} coverage`;

  test(`${label}: the schema enforces the hash and status invariants`, { skip }, async () => {
    const pool = mysql.createPool(url);
    const names = tableNames();
    try {
      await migrate(pool, names);
      const insert = (hash, status) =>
        pool.query(
          `INSERT INTO ${names.tableName} (reference, payment_hash, status, expires_at, created_at, updated_at, inserted_at, checkout_data) VALUES ('r', ?, ?, 1, 1, 1, 1, '{}')`,
          [hash, status],
        );
      await insert("a".repeat(64), "pending");
      await assert.rejects(insert("A".repeat(64), "pending"), /check|constraint/i);
      await assert.rejects(insert("b".repeat(63), "pending"), /check|constraint/i);
      await assert.rejects(insert("c".repeat(64), "bogus"), /check|constraint/i);
      const [[seed]] = await pool.query(
        `SELECT value FROM ${names.metaTableName} WHERE \`key\` = 'schema_version'`,
      );
      assert.equal(seed.value, "1");
    } finally {
      await drop(pool, names);
      await pool.end();
    }
  });

  test(`${label}: a mysql2 Pool runs the payments contract`, { skip }, async () => {
    const pool = mysql.createPool({ uri: url, connectionLimit: 5 });
    const names = tableNames();
    try {
      await migrate(pool, names);
      await exerciseContract(pool, pool, names, { concurrent: true });
    } finally {
      await drop(pool, names);
      await pool.end();
    }
  });

  test(`${label}: a single mysql2 Connection serializes the contract in-process`, {
    skip,
  }, async () => {
    const pool = mysql.createPool(url);
    const connection = await mysql.createConnection(url);
    const names = tableNames();
    try {
      await migrate(pool, names);
      await exerciseContract(connection, pool, names, { concurrent: false });
    } finally {
      await drop(pool, names);
      await connection.end();
      await pool.end();
    }
  });

  test(`${label}: a callback-API mysql2 Pool binds through promise()`, { skip }, async () => {
    const pool = mysql.createPool(url);
    const callbackPool = mysqlCallback.createPool(url);
    const names = tableNames();
    try {
      await migrate(pool, names);
      await exerciseContract(callbackPool, pool, names, { concurrent: true });
    } finally {
      await drop(pool, names);
      await pool.end();
      await new Promise((resolve) => callbackPool.end(resolve));
    }
  });

  test(`${label}: Knex (mysql2) runs the contract with SQL passed verbatim`, { skip }, async () => {
    const pool = mysql.createPool(url);
    const knex = knexFactory({ client: "mysql2", connection: url, pool: { min: 0, max: 5 } });
    const names = tableNames();
    try {
      await migrate(pool, names);
      const db = knexDb(knex, "mysql");
      assert.deepEqual(await db.query("SELECT '?' AS literal, '??' AS doubled"), [
        { literal: "?", doubled: "??" },
      ]);
      assert.deepEqual(await db.query("SELECT ? AS first, ? AS second", ["one", 2]), [
        { first: "one", second: 2 },
      ]);
      await exerciseContract(db, pool, names, { concurrent: true });
      assert.equal(knex.client.pool.numUsed(), 0, "all acquired connections released");
    } finally {
      await drop(pool, names);
      await knex.destroy();
      await pool.end();
    }
  });

  test(`${label}: TypeORM runs the contract`, { skip }, async () => {
    const pool = mysql.createPool(url);
    const dataSource = new DataSource({ type: "mysql", url });
    const names = tableNames();
    try {
      await migrate(pool, names);
      await dataSource.initialize();
      await exerciseContract(typeOrmDb(dataSource, "mysql"), pool, names, { concurrent: true });
    } finally {
      await drop(pool, names);
      if (dataSource.isInitialized) await dataSource.destroy();
      await pool.end();
    }
  });

  test(`${label}: Prisma (driver adapter) runs the contract`, { skip }, async () => {
    const pool = mysql.createPool(url);
    const prisma = new PrismaClient({ adapter: new PrismaMariaDb(url) });
    const names = tableNames();
    try {
      await migrate(pool, names);
      await exerciseContract(prismaDb(prisma, "mysql"), pool, names, { concurrent: true });
    } finally {
      await drop(pool, names);
      await prisma.$disconnect();
      await pool.end();
    }
  });

  test(`${label}: the scaffolded Knex migration applies and rolls back`, { skip }, async () => {
    const names = tableNames();
    const options = finalizeScaffoldOptions({
      orm: "knex",
      dialect: "mysql",
      tableName: names.tableName,
      metaTableName: names.metaTableName,
      force: false,
      outDir: ".",
    });
    const migration = renderScaffoldPaymentsFiles(options).find((file) =>
      file.path.startsWith("db/migrations/"),
    );
    const directory = await mkdtemp(path.join(tmpdir(), "openreceive-mysql-migration-"));
    const file = path.join(directory, "migration.mjs");
    await writeFile(file, migration.contents);
    const { up, down } = await import(pathToFileURL(file).href);
    const knex = knexFactory({ client: "mysql2", connection: url, pool: { min: 0, max: 2 } });
    try {
      await up(knex);
      await up(knex);
      const payments = createSqlPayments(knexDb(knex, "mysql"), { ...names, clock: () => 1_000 });
      await payments.commitAttempt(attempt("migrated", "a"));
      assert.equal((await payments.listForReference("migrated")).length, 1);
      await down(knex);
      await assert.rejects(payments.listForReference("migrated"));
    } finally {
      await knex.raw(`DROP TABLE IF EXISTS ${names.tableName}, ${names.metaTableName}`);
      await knex.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`${label}: unmigrated and newer-schema databases are refused`, { skip }, async () => {
    const pool = mysql.createPool(url);
    const names = tableNames();
    try {
      await assert.rejects(
        createSqlPayments(pool, names).listForReference("order"),
        /have not been migrated/,
      );
      await migrate(pool, names);
      await pool.query(
        `UPDATE ${names.metaTableName} SET value = '999' WHERE \`key\` = 'schema_version'`,
      );
      await assert.rejects(
        createSqlPayments(pool, names).listForReference("order"),
        /newer than this library/,
      );
    } finally {
      await drop(pool, names);
      await pool.end();
    }
  });
}
