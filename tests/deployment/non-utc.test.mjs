import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import pg from "pg";
import {
  createHost,
  createSqlPayments,
  OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS,
  paymentsSchemaStatements,
  reconcileHostPayments,
} from "../../packages/js/http/src/index.ts";
import { createOpenReceive } from "../../packages/js/node/src/index.ts";
import { createTestkitReceiveClient } from "../../packages/js/testkit/src/index.ts";

// A database that is not set to UTC. The session is forced to Asia/Tokyo
// (UTC+9) whatever the server was started with, so this holds in CI too;
// `tools/ci/deployment-edge-tests.sh` also runs it against servers configured
// that way, and with TZ=America/New_York for the process. Node stores unix
// seconds in BIGINT columns, so the session zone should change nothing: an
// offset leaking into this path would move a row by nine hours, which the
// expiry boundaries below would see in both directions.

const URLS = {
  postgres: process.env.OPENRECEIVE_TEST_POSTGRES_URL,
  mysql: process.env.OPENRECEIVE_TEST_MYSQL_URL,
};

const NINE_HOURS = 9 * 3_600;
const GRACE = OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS;

async function tokyoSession(dialect) {
  if (dialect === "postgres") {
    const db = new pg.Pool({
      connectionString: URLS.postgres,
      options: "-c timezone=Asia/Tokyo",
      max: 4,
    });
    const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
    const [{ TimeZone }] = await rows("SHOW TimeZone");
    assert.equal(TimeZone, "Asia/Tokyo", "this test needs a non-UTC session");
    return { db, rows, close: () => db.end() };
  }
  const db = await mysql.createConnection(URLS.mysql);
  await db.query("SET time_zone = '+09:00'");
  const rows = async (sql, params = []) => (await db.query(sql, params))[0];
  const [{ zone }] = await rows("SELECT @@session.time_zone AS zone");
  assert.equal(zone, "+09:00", "this test needs a non-UTC session");
  return { db, rows, close: () => db.end() };
}

let serial = 0;
async function fixture(dialect) {
  serial += 1;
  const suffix = `${process.pid}_${Date.now() % 100_000_000}_${serial}`;
  const tableName = `edge_tz_payments_${suffix}`;
  const metaTableName = `edge_tz_meta_${suffix}`;
  const session = await tokyoSession(dialect);
  for (const statement of paymentsSchemaStatements(dialect, tableName, metaTableName)) {
    await session.rows(statement);
  }
  const now = Math.floor(Date.now() / 1000);
  const clock = () => now;
  const payments = createSqlPayments(session.db, { tableName, metaTableName, clock });
  return {
    ...session,
    tableName,
    now,
    clock,
    payments,
    cleanup: async () => {
      await session.rows(`DROP TABLE IF EXISTS ${tableName}`);
      await session.rows(`DROP TABLE IF EXISTS ${metaTableName}`);
      await session.close();
    },
  };
}

function attempt(reference, character, createdAt, expiresAt, clientIp) {
  const paymentHash = character.repeat(64);
  return {
    reference,
    paymentHash,
    ...(clientIp === undefined ? {} : { clientIp }),
    checkout: {
      reference,
      paymentHash,
      bolt11: `lnbc-${character}`,
      amountMsats: 1_000,
      createdAt,
      createdAtSource: "wallet",
      expiresAt,
      fiatQuote: null,
    },
  };
}

for (const dialect of ["postgres", "mysql"]) {
  const skip = URLS[dialect] ? false : `Set the ${dialect} test URL for this lane`;

  test(`${dialect}: rows hold exact unix seconds in a Tokyo session`, { skip }, async (t) => {
    const f = await fixture(dialect);
    t.after(f.cleanup);
    const createdAt = f.now - 60;
    const expiresAt = f.now + 540;
    await f.payments.commitAttempt(attempt("row", "a", createdAt, expiresAt));
    const [row] = await f.rows(`SELECT created_at, expires_at, inserted_at FROM ${f.tableName}`);
    assert.equal(Number(row.created_at), createdAt);
    assert.equal(Number(row.expires_at), expiresAt);
    assert.equal(Number(row.inserted_at), f.now);
    const [record] = await f.payments.listForReference("row");
    assert.equal(record.expiresAt, expiresAt);
    assert.equal(record.createdAt, createdAt);

    const paidAt = f.now + 10;
    await f.payments.markPaidOnce({ paymentHash: "a".repeat(64), paidAt }, async () => undefined);
    const [paid] = await f.rows(`SELECT paid_at, status FROM ${f.tableName}`);
    assert.equal(Number(paid.paid_at), paidAt);
    assert.equal(paid.status, "settled");
  });

  test(`${dialect}: expiry closes on the clock, nine hours from nowhere`, { skip }, async (t) => {
    const f = await fixture(dialect);
    t.after(f.cleanup);
    const client = createTestkitReceiveClient({ now: f.clock });
    const service = await createOpenReceive({ client, clock: f.clock, priceProviders: [] });
    const host = createHost({
      payments: f.payments,
      clock: f.clock,
      amountFor: () => ({ sats: 1 }),
      onPaid: async () => undefined,
    });
    const past = f.now - GRACE - 1;
    const inGrace = f.now - GRACE + 120;
    const live = f.now + 300;
    for (const [character, expiresAt] of [
      ["a", past],
      ["b", inGrace],
      ["c", live],
    ]) {
      await f.payments.commitAttempt(
        attempt(`close-${character}`, character, expiresAt - 600, expiresAt),
      );
    }
    // The wallet has never heard of these three: only the clock can close one.
    await reconcileHostPayments({ service, host, clock: f.clock });
    const rows = await f.rows(
      `SELECT payment_hash, status, status_reason FROM ${f.tableName} ORDER BY payment_hash`,
    );
    assert.deepEqual(
      rows.map((row) => `${row.payment_hash[0]}:${row.status}:${row.status_reason ?? "-"}`),
      ["a:expired:not_found_after_expiry", "b:pending:-", "c:pending:-"],
    );
  });

  test(`${dialect}: an attempt reads as live or stale by its own unix seconds`, {
    skip,
  }, async (t) => {
    const f = await fixture(dialect);
    t.after(f.cleanup);
    await f.payments.commitAttempt(attempt("same", "a", f.now - 30, f.now + 1));
    const [row] = await f.payments.listForReference("same");
    assert.ok(row.expiresAt > f.now, "not expired yet");
    const live = await f.payments.listReconcilableAttempts();
    assert.equal(live.length, 1);
    assert.equal(live[0].expiresAt, f.now + 1);
    assert.equal(live[0].createdAt, f.now - 30);

    // The keyset: an attempt 9 hours off would be skipped or re-read.
    assert.deepEqual(
      await f.payments.listReconcilableAttempts({
        created_at: f.now - 30,
        payment_hash: "0".repeat(64),
      }),
      live,
    );
    assert.deepEqual(
      await f.payments.listReconcilableAttempts({
        created_at: f.now + NINE_HOURS,
        payment_hash: "0".repeat(64),
      }),
      [],
    );
  });

  test(`${dialect}: the rate-limit window counts by unix seconds`, { skip }, async (t) => {
    const f = await fixture(dialect);
    t.after(f.cleanup);
    await f.payments.commitAttempt(attempt("rate", "a", f.now, f.now + 600, "203.0.113.5"));
    assert.equal(await f.payments.countAttemptsFromIp("203.0.113.5", f.now - 1), 1);
    assert.equal(await f.payments.countAttemptsFromIp("203.0.113.5", f.now + 1), 0);
    assert.equal(await f.payments.countAttemptsFromIp("203.0.113.5", f.now - NINE_HOURS - 1), 1);
    assert.equal(await f.payments.countAttemptsFromIp("203.0.113.5", f.now + NINE_HOURS + 1), 0);
  });

  test(`${dialect}: the gate holds across a non-UTC session`, { skip }, async (t) => {
    const f = await fixture(dialect);
    t.after(f.cleanup);
    assert.ok(await f.payments.claimReconcileGate({ now: f.now, intervalSeconds: 3 }));
    assert.equal(await f.payments.claimReconcileGate({ now: f.now + 2, intervalSeconds: 3 }), null);
    assert.ok(await f.payments.claimReconcileGate({ now: f.now + 11, intervalSeconds: 3 }));
  });
}

// What a host's own paid_at does, as the guides write it. `paidAt` is unix
// seconds: the guides say to convert in SQL, and these pin what each column
// type then holds on a database that is not UTC.
test("postgres: the guides' paid_at SQL per column type", { skip: !URLS.postgres }, async (t) => {
  const f = await fixture("postgres");
  t.after(f.cleanup);
  const orders = `edge_tz_orders_${process.pid}_${Date.now() % 100_000_000}`;
  await f.rows(
    `CREATE TABLE ${orders} (id TEXT PRIMARY KEY, paid_tz TIMESTAMPTZ, paid_naive TIMESTAMP)`,
  );
  t.after(() => f.rows(`DROP TABLE IF EXISTS ${orders}`).catch(() => {}));
  await f.rows(`INSERT INTO ${orders} (id) VALUES ('order')`);

  const paidAt = f.now;
  await f.rows(
    `UPDATE ${orders} SET paid_tz = to_timestamp($1), paid_naive = to_timestamp($1) WHERE id = 'order'`,
    [paidAt],
  );
  const [row] = await f.rows(
    `SELECT EXTRACT(EPOCH FROM paid_tz)::bigint AS tz_epoch, EXTRACT(EPOCH FROM paid_naive)::bigint AS naive_epoch FROM ${orders}`,
  );
  assert.equal(Number(row.tz_epoch), paidAt, "TIMESTAMPTZ holds the exact instant");
  // TIMESTAMP (no time zone) keeps the session's wall clock: nine hours ahead
  // of what a reader treating the column as UTC expects. The guides'
  // to_timestamp() is right for TIMESTAMPTZ.
  assert.equal(Number(row.naive_epoch), paidAt + NINE_HOURS);

  // A bare number is what the guides warn about: the settlement would never commit.
  await assert.rejects(f.rows(`UPDATE ${orders} SET paid_tz = $1 WHERE id = 'order'`, [paidAt]));
});

test("mysql: the guides' paid_at SQL per column type", { skip: !URLS.mysql }, async (t) => {
  const f = await fixture("mysql");
  t.after(f.cleanup);
  const orders = `edge_tz_orders_${process.pid}_${Date.now() % 100_000_000}`;
  await f.rows(
    `CREATE TABLE ${orders} (id VARCHAR(32) PRIMARY KEY, paid_dt DATETIME NULL, paid_ts TIMESTAMP NULL)`,
  );
  t.after(() => f.rows(`DROP TABLE IF EXISTS ${orders}`).catch(() => {}));
  await f.rows(`INSERT INTO ${orders} (id) VALUES ('order')`);

  const paidAt = f.now;
  await f.rows(
    `UPDATE ${orders} SET paid_dt = FROM_UNIXTIME(?), paid_ts = FROM_UNIXTIME(?) WHERE id = 'order'`,
    [paidAt, paidAt],
  );
  const [row] = await f.rows(
    `SELECT UNIX_TIMESTAMP(paid_ts) AS ts_epoch, UNIX_TIMESTAMP(paid_dt) AS dt_epoch,
            CAST(paid_dt AS CHAR) AS dt_text, CAST(UTC_TIMESTAMP() AS CHAR) AS utc_text FROM ${orders}`,
  );
  assert.equal(Number(row.ts_epoch), paidAt, "TIMESTAMP holds the exact instant");
  assert.equal(
    Number(row.dt_epoch),
    paidAt,
    "UNIX_TIMESTAMP reads it back in the same session zone",
  );
  // FROM_UNIXTIME into DATETIME stores the session's wall clock (+09:00), so a
  // reader that treats the column as UTC sees nine hours ahead.
  const dtHourAsUtc = Date.parse(`${row.dt_text.replace(" ", "T")}Z`) / 1000;
  assert.equal(Math.round((dtHourAsUtc - paidAt) / 3600), 9);

  await assert.rejects(
    f.rows(`UPDATE ${orders} SET paid_dt = ? WHERE id = 'order'`, ["not a date"]),
  );
});
