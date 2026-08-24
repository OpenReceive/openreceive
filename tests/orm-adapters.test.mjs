import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { paymentsSchemaSql } from "../packages/js/http/src/index.ts";
import { knexDb, prismaDb, typeOrmDb } from "../packages/js/http/src/orm-adapters.ts";

// ---------------------------------------------------------------------------
// knexDb — the per-driver RESULT shape is the whole reason the factory exists:
// knex's sqlite3 driver resolves the rows array itself, pg wraps it in
// `{ rows }`.

function fakeKnex(rawResult) {
  const calls = [];
  const rawOn = (scope) => async (sql, bindings) => {
    calls.push({ scope, sql, bindings });
    return rawResult;
  };
  return {
    calls,
    raw: rawOn("root"),
    transaction: (run) => run({ raw: rawOn("trx") }),
  };
}

test("knexDb postgres unwraps the pg driver's { rows }", async () => {
  const knex = fakeKnex({ rows: [{ id: 1 }] });
  const rows = await knexDb(knex, "postgres").query("SELECT 1", [7]);
  assert.deepEqual(rows, [{ id: 1 }]);
  assert.deepEqual(knex.calls, [{ scope: "root", sql: "SELECT 1", bindings: [7] }]);
});

test("knexDb sqlite passes the driver's rows array through", async () => {
  const knex = fakeKnex([{ id: 1 }, { id: 2 }]);
  const rows = await knexDb(knex, "sqlite").query("SELECT 1");
  // `result[0]` here would be the first ROW — the exact break the factory guards.
  assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
});

test("knexDb transactions query through the trx executor, not the root", async () => {
  const knex = fakeKnex({ rows: [] });
  await knexDb(knex, "postgres").transaction((tx) => tx.query("UPDATE t SET x = $1", [1]));
  assert.deepEqual(knex.calls, [{ scope: "trx", sql: "UPDATE t SET x = $1", bindings: [1] }]);
});

// ---------------------------------------------------------------------------
// prismaDb — Prisma splits raw SQL across $queryRawUnsafe (rows) and
// $executeRawUnsafe (affected count), so the factory routes by statement.

function fakePrisma() {
  const calls = [];
  const executorOn = (scope) => ({
    $queryRawUnsafe: async (sql, ...params) => {
      calls.push({ scope, kind: "query", sql, params });
      return [{ id: "row" }];
    },
    $executeRawUnsafe: async (sql, ...params) => {
      calls.push({ scope, kind: "execute", sql, params });
      return 1;
    },
  });
  return {
    calls,
    ...executorOn("root"),
    $transaction: (run) => run(executorOn("tx")),
  };
}

test("prismaDb routes SELECT/VALUES/WITH heads through $queryRawUnsafe", async () => {
  const prisma = fakePrisma();
  const adapter = prismaDb(prisma, "postgres");
  assert.deepEqual(await adapter.query("SELECT 1"), [{ id: "row" }]);
  assert.deepEqual(await adapter.query(" with c as (select 1) select * from c"), [{ id: "row" }]);
  assert.deepEqual(
    prisma.calls.map((call) => call.kind),
    ["query", "query"],
  );
});

test("prismaDb routes RETURNING through $queryRawUnsafe — the onPaid claim depends on its rows", async () => {
  const prisma = fakePrisma();
  const claimed = await prismaDb(prisma, "postgres").query(
    "UPDATE orders SET state = 'paid' WHERE id = $1 AND state = 'awaiting_payment' RETURNING id",
    ["order-1"],
  );
  assert.deepEqual(claimed, [{ id: "row" }]);
  assert.deepEqual(prisma.calls, [
    {
      scope: "root",
      kind: "query",
      sql: "UPDATE orders SET state = 'paid' WHERE id = $1 AND state = 'awaiting_payment' RETURNING id",
      params: ["order-1"],
    },
  ]);
});

test("prismaDb runs row-less statements through $executeRawUnsafe and answers []", async () => {
  const prisma = fakePrisma();
  const rows = await prismaDb(prisma, "sqlite").query("UPDATE t SET x = ? WHERE id = ?", [1, 2]);
  assert.deepEqual(rows, []);
  assert.deepEqual(prisma.calls, [
    { scope: "root", kind: "execute", sql: "UPDATE t SET x = ? WHERE id = ?", params: [1, 2] },
  ]);
});

test("prismaDb transactions query through the interactive-transaction client", async () => {
  const prisma = fakePrisma();
  await prismaDb(prisma, "postgres").transaction((tx) => tx.query("SELECT 1"));
  assert.deepEqual(
    prisma.calls.map((call) => call.scope),
    ["tx"],
  );
});

// ---------------------------------------------------------------------------
// typeOrmDb — query passes through verbatim; the transaction must use the
// transaction's own EntityManager or settlement statements land outside it.

function fakeDataSource() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ scope: "root", sql, params });
      return [{ id: 1 }];
    },
    transaction: (run) =>
      run({
        query: async (sql, params) => {
          calls.push({ scope: "manager", sql, params });
          return undefined; // typeorm resolves nothing for row-less statements
        },
      }),
  };
}

test("typeOrmDb returns rows verbatim and [] for a nullish driver result", async () => {
  const dataSource = fakeDataSource();
  const adapter = typeOrmDb(dataSource, "postgres");
  assert.deepEqual(await adapter.query("SELECT 1", [3]), [{ id: 1 }]);
  assert.deepEqual(await adapter.transaction((tx) => tx.query("UPDATE t SET x = $1", [1])), []);
});

test("typeOrmDb transactions query through the manager, never the DataSource", async () => {
  const dataSource = fakeDataSource();
  await typeOrmDb(dataSource, "postgres").transaction((tx) => tx.query("SELECT 1"));
  assert.deepEqual(
    dataSource.calls.map((call) => call.scope),
    ["manager"],
  );
});

// ---------------------------------------------------------------------------
// End-to-end over a real database: a knex-sqlite3-shaped shim on node:sqlite
// proves the factory's contract holds against the real payments schema —
// parameterized writes, reads, and transaction rollback.

function sqliteKnexShim(db) {
  // knex('sqlite3') semantics: raw() resolves the rows array itself, and
  // transaction() wraps the callback in BEGIN/COMMIT with rollback on throw.
  const raw = async (sql, bindings) => {
    const statement = db.prepare(sql);
    if (/^\s*(?:select|values|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      return statement.all(...bindings);
    }
    statement.run(...bindings);
    return [];
  };
  return {
    raw,
    transaction: async (run) => {
      db.exec("BEGIN");
      try {
        const result = await run({ raw });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("knexDb over sqlite runs writes, reads, and rollback against the payments schema", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(paymentsSchemaSql("sqlite"));
  const adapter = knexDb(sqliteKnexShim(db), "sqlite");

  const insert = `INSERT INTO openreceive_meta (key, value, rev) VALUES (?, ?, 0)`;
  assert.deepEqual(await adapter.query(insert, ["k1", "v1"]), []);
  const selected = await adapter.query(`SELECT key, value FROM openreceive_meta WHERE key = ?`, [
    "k1",
  ]);
  // node:sqlite rows are null-prototype objects; spread for the strict compare.
  assert.deepEqual(
    selected.map((row) => ({ ...row })),
    [{ key: "k1", value: "v1" }],
  );

  await assert.rejects(
    adapter.transaction(async (tx) => {
      await tx.query(insert, ["k2", "v2"]);
      throw new Error("abort");
    }),
    /abort/,
  );
  assert.deepEqual(
    await adapter.query(`SELECT key FROM openreceive_meta WHERE key = ?`, ["k2"]),
    [],
  );
});
