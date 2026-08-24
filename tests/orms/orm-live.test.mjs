import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import knexFactory from "knex";
import { DataSource } from "typeorm";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/client.ts";
import {
  createSqlPayments,
  knexDb,
  paymentsSchemaSql,
  prismaDb,
  typeOrmDb,
} from "../../packages/js/http/src/index.ts";
import { hash } from "../helpers/factories.mjs";

// The real-ORM lane behind `npm run test:orms`: the unit suite pins each
// factory's mapping against fakes; this lane proves the mapping against the
// actual ORMs — each drives the real payments repository (commit, write-once
// settlement, reconcile-gate CAS) over its own sqlite connection. Not part of
// the deterministic gate: it needs the ORM devDependencies and Prisma's
// generated client (`prisma generate` runs inside the npm script).

function freshDatabase() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "openreceive-orm-")), "payments.db");
  const db = new DatabaseSync(file);
  db.exec(paymentsSchemaSql("sqlite"));
  db.close();
  return file;
}

function checkoutInput(reference, character) {
  const paymentHash = hash(character);
  return {
    reference,
    paymentHash,
    checkout: {
      reference,
      paymentHash,
      bolt11: `lnbc-${character}`,
      amountMsats: 1_000,
      createdAt: 900,
      expiresAt: 1_600,
      fiatQuote: null,
    },
  };
}

async function exercisePayments(adapter) {
  const payments = createSqlPayments(adapter, { clock: () => 1_000 });

  await payments.commitAttempt(checkoutInput("order-1", "a"));
  const pending = await payments.listForReference("order-1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].checkout.bolt11, "lnbc-a");

  let fulfilled = 0;
  const fulfill = async () => {
    fulfilled += 1;
  };
  await payments.markPaidOnce({ paymentHash: hash("a"), paidAt: 990 }, fulfill);
  await payments.markPaidOnce({ paymentHash: hash("a"), paidAt: 990 }, fulfill);
  assert.equal(fulfilled, 1, "write-once settlement fulfills exactly once");

  const settled = await payments.listForReference("order-1");
  assert.equal(settled[0].status, "settled");
  assert.equal(settled[0].paidAt, 990);

  assert.equal(await payments.claimReconcileGate({ now: 1_000, intervalSeconds: 60 }), true);
  assert.equal(await payments.claimReconcileGate({ now: 1_010, intervalSeconds: 60 }), false);
}

test("knex (better-sqlite3) drives the payments repository through knexDb", async () => {
  const knex = knexFactory({
    client: "better-sqlite3",
    connection: { filename: freshDatabase() },
    useNullAsDefault: true,
  });
  try {
    await exercisePayments(knexDb(knex, "sqlite"));
  } finally {
    await knex.destroy();
  }
});

test("typeorm (better-sqlite3) drives the payments repository through typeOrmDb", async () => {
  const dataSource = new DataSource({ type: "better-sqlite3", database: freshDatabase() });
  await dataSource.initialize();
  try {
    await exercisePayments(typeOrmDb(dataSource, "sqlite"));
  } finally {
    await dataSource.destroy();
  }
});

test("prisma (driver adapter) drives the payments repository through prismaDb", async () => {
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${freshDatabase()}` }),
  });
  try {
    await exercisePayments(prismaDb(prisma, "sqlite"));
  } finally {
    await prisma.$disconnect();
  }
});
