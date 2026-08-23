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
