import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { resolveSqlAdapter } from "../packages/js/http/src/sql-adapters.ts";

// A pg.Client stand-in: connect() may be called exactly once, and query()
// calls made before connect() queue indefinitely (pg's real behavior).
function fakePgClient() {
  let connected = false;
  let connectCalls = 0;
  const waiting = [];
  return {
    connectCallCount: () => connectCalls,
    async connect() {
      connectCalls += 1;
      if (connected) {
        throw new Error("Client has already been connected. You cannot reuse a client.");
      }
      connected = true;
      for (const resume of waiting.splice(0)) resume();
    },
    query(sql, params) {
      if (!connected) {
        return new Promise((resolve) => {
          waiting.push(() => resolve({ rows: [{ sql, params }] }));
        });
      }
      return Promise.resolve({ rows: [{ sql, params }] });
    },
  };
}

// A pg.Pool stand-in without the structural counter getters, so the adapter
// must discover pool mode through its connect() probe.
function fakeUncountedPool() {
  const checkouts = [];
  return {
    checkouts,
    async connect() {
      const client = {
        released: false,
        query: (sql, params) => Promise.resolve({ rows: [{ sql, params }] }),
        release() {
          client.released = true;
        },
      };
      checkouts.push(client);
      return client;
    },
    query: (sql, params) => Promise.resolve({ rows: [{ sql, params }] }),
  };
}

test("concurrent first transactions on a pg Client share one connect probe", async () => {
  const client = fakePgClient();
  const adapter = resolveSqlAdapter(client);
  const [first, second] = await Promise.all([
    adapter.transaction((tx) => tx.query("SELECT 1")),
    adapter.transaction((tx) => tx.query("SELECT 2")),
  ]);
  assert.equal(first[0].sql, "SELECT 1");
  assert.equal(second[0].sql, "SELECT 2");
  assert.equal(client.connectCallCount(), 1);
});

test("a plain read on a never-connected pg Client connects instead of hanging", async () => {
  const client = fakePgClient();
  const adapter = resolveSqlAdapter(client);
  const rows = await adapter.query("SELECT value FROM openreceive_meta");
  assert.equal(rows[0].sql, "SELECT value FROM openreceive_meta");
  assert.equal(client.connectCallCount(), 1);
});

test("concurrent first transactions on an uncounted pool each get their own client", async () => {
  const pool = fakeUncountedPool();
  const adapter = resolveSqlAdapter(pool);
  await Promise.all([
    adapter.transaction((tx) => tx.query("SELECT 1")),
    adapter.transaction((tx) => tx.query("SELECT 2")),
  ]);
  assert.equal(pool.checkouts.length, 2);
  for (const client of pool.checkouts) assert.equal(client.released, true);
});

test("sqlite adapter returns rows for RETURNING and WITH statements", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE fruits (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  const adapter = resolveSqlAdapter(db);

  const inserted = await adapter.transaction((tx) =>
    tx.query("INSERT INTO fruits (name) VALUES (?) RETURNING id, name", ["apple"]),
  );
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].name, "apple");

  const viaCte = await adapter.query(
    "WITH named AS (SELECT name FROM fruits) SELECT name FROM named",
  );
  assert.deepEqual(
    viaCte.map((row) => row.name),
    ["apple"],
  );

  const topLevel = await adapter.query("INSERT INTO fruits (name) VALUES (?) RETURNING name", [
    "pear",
  ]);
  assert.equal(topLevel[0].name, "pear");
});

test("sqlite adapter trusts better-sqlite3's reader flag over statement shape", async () => {
  const runs = [];
  const fake = {
    prepare(sql) {
      return {
        // better-sqlite3 marks a row-less WITH…INSERT as a non-reader, where
        // .all() would throw.
        reader: false,
        all() {
          throw new Error("This statement does not return data. Use run() instead");
        },
        run(...params) {
          runs.push({ sql, params });
          return {};
        },
      };
    },
    exec() {},
  };
  const adapter = resolveSqlAdapter(fake);
  const rows = await adapter.query(
    "WITH seed AS (SELECT 'kiwi' AS name) INSERT INTO fruits (name) SELECT name FROM seed",
  );
  assert.deepEqual(rows, []);
  assert.equal(runs.length, 1);
});

// mysql2 stand-ins: a promise Pool checks out a connection per transaction, a
// promise Connection is one session, and the callback API reaches the promise
// shape through promise(). query() resolves [rows, fields] for a SELECT and
// [ResultSetHeader] for a write.
function fakeMysqlSession(log, name) {
  return {
    async query(sql, values) {
      log.push({ name, sql, values });
      return /^\s*select/i.test(sql) ? [[{ sql }], []] : [{ affectedRows: 1 }];
    },
    async execute() {},
    async beginTransaction() {
      log.push({ name, sql: "BEGIN" });
    },
    async commit() {
      log.push({ name, sql: "COMMIT" });
    },
    async rollback() {
      log.push({ name, sql: "ROLLBACK" });
    },
    release() {
      log.push({ name, sql: "RELEASE" });
    },
  };
}

test("a mysql2 Pool runs each transaction on its own checked-out connection", async () => {
  const log = [];
  let checkouts = 0;
  const pool = {
    ...fakeMysqlSession(log, "pool"),
    beginTransaction: undefined,
    async getConnection() {
      checkouts += 1;
      return fakeMysqlSession(log, `conn-${checkouts}`);
    },
  };
  const adapter = resolveSqlAdapter(pool);
  assert.equal(adapter.dialect, "mysql");
  // Verbatim, and no values means no formatting at all.
  assert.deepEqual(await adapter.query("SELECT '?' AS literal"), [
    { sql: "SELECT '?' AS literal" },
  ]);
  assert.equal(log[0].values, undefined);
  assert.deepEqual(await adapter.query("UPDATE t SET x = ?", [1]), []);
  await assert.rejects(
    adapter.transaction(async (tx) => {
      await tx.query("UPDATE t SET x = ?", [2]);
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.deepEqual(
    log.slice(2).map((entry) => `${entry.name}:${entry.sql}`),
    ["conn-1:BEGIN", "conn-1:UPDATE t SET x = ?", "conn-1:ROLLBACK", "conn-1:RELEASE"],
  );
});

test("a mysql2 Connection serializes transactions and reads in-process", async () => {
  const log = [];
  const adapter = resolveSqlAdapter(fakeMysqlSession(log, "conn"));
  assert.equal(adapter.dialect, "mysql");
  let releaseFirst;
  const first = adapter.transaction(async (tx) => {
    await tx.query("UPDATE t SET x = ?", [1]);
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
  });
  const read = adapter.query("SELECT x FROM t");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!log.some((entry) => entry.sql === "SELECT x FROM t"), "the read waited");
  releaseFirst();
  await first;
  await read;
  assert.deepEqual(
    log.map((entry) => entry.sql),
    ["BEGIN", "UPDATE t SET x = ?", "COMMIT", "SELECT x FROM t"],
  );
});

test("a callback-API mysql2 handle binds through its promise() wrapper", async () => {
  const log = [];
  const promised = fakeMysqlSession(log, "promised");
  const callbackPool = {
    query() {
      throw new Error("callback API used without promise()");
    },
    execute() {},
    getConnection() {},
    promise: () => ({ ...promised, getConnection: async () => promised }),
  };
  const adapter = resolveSqlAdapter(callbackPool);
  assert.equal(adapter.dialect, "mysql");
  assert.deepEqual(await adapter.query("SELECT 1"), [{ sql: "SELECT 1" }]);
});
