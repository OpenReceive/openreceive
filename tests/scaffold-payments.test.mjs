import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  finalizeScaffoldOptions,
  parseScaffoldPaymentsArgv,
  renderScaffoldPaymentsFiles,
  runOpenReceiveCli,
} from "../packages/js/node/src/cli.ts";
import { OPENRECEIVE_DIALECTS, OPENRECEIVE_ORMS } from "../packages/js/node/src/scaffold/types.ts";
import { canonicalPaymentsDdlStatements } from "../packages/js/node/src/scaffold/shared.ts";
import { openReceivePaymentsSchemaSql } from "../packages/js/http/src/sql-payments.ts";

const SCHEMA_PATHS = {
  prisma: "prisma/schema.openreceive.prisma",
  drizzle: "src/db/openreceive-tables.ts",
  typeorm: "src/migrations/20260101000000-create-openreceive-tables.ts",
  sequelize: "migrations/20260101000000-create-openreceive-tables.cjs",
  knex: "db/migrations/20260101000000_create_openreceive_tables.mjs",
};

const CANONICAL_COLUMNS = [
  /order_id|orderId/,
  /payment_hash|paymentHash/,
  /\bstatus\b/,
  /status_reason|statusReason/,
  /paid_at|paidAt/,
  /expires_at|expiresAt/,
  /created_at|createdAt/,
  /updated_at|updatedAt/,
  /checkout_data|checkoutData/,
  /swap_data|swapData/,
  /client_ip|clientIp/,
];

function renderFor(orm, dialect, extra = {}) {
  return renderScaffoldPaymentsFiles(
    finalizeScaffoldOptions({
      orm,
      dialect,
      force: false,
      skipForeignKey: false,
      outDir: ".",
      ...extra,
    }),
  );
}

function schemaFile(files, orm) {
  const file = files.find((candidate) => candidate.path === SCHEMA_PATHS[orm]);
  assert.ok(file, `missing schema/migration file for ${orm}`);
  return file;
}

function guideFile(files) {
  const file = files.find((candidate) => candidate.path === "OPENRECEIVE_PAYMENTS.md");
  assert.ok(file, "missing OPENRECEIVE_PAYMENTS.md");
  return file;
}

test("scaffold payments help is advertised from the root CLI", async () => {
  const lines = [];
  const code = await runOpenReceiveCli({
    argv: ["help"],
    cwd: process.cwd(),
    stdout: { write: (message) => lines.push(message) },
    stderr: { write: () => {} },
    isTTY: false,
  });
  assert.equal(code, 0);
  assert.match(lines.join(""), /scaffold payments/);
});

test("scaffold payments help documents flags and the schema-plus-guide contract", async () => {
  const lines = [];
  const code = await runOpenReceiveCli({
    argv: ["scaffold", "payments", "--help"],
    cwd: process.cwd(),
    stdout: { write: (message) => lines.push(message) },
    stderr: { write: () => {} },
    isTTY: false,
  });
  assert.equal(code, 0);
  const text = lines.join("");
  assert.match(text, /--dialect/);
  assert.match(text, /postgres \| sqlite/);
  assert.match(text, /schema\/migration/);
  assert.match(text, /wiring guide/);
  assert.match(text, /OpenReceive owns the\s+payment-attempt repository/);
});

test("scaffold payments requires --orm when not interactive", async () => {
  const errors = [];
  const code = await runOpenReceiveCli({
    argv: ["scaffold", "payments"],
    cwd: process.cwd(),
    stdout: { write: () => {} },
    stderr: { write: (message) => errors.push(message) },
    isTTY: false,
  });
  assert.equal(code, 1);
  assert.match(errors.join(""), /Missing --orm|--orm/);
});

test("parseScaffoldPaymentsArgv accepts ORM, dialect, and order flags", () => {
  for (const orm of OPENRECEIVE_ORMS) {
    for (const dialect of OPENRECEIVE_DIALECTS) {
      const parsed = parseScaffoldPaymentsArgv([
        "--orm",
        orm,
        "--dialect",
        dialect,
        "--order-model",
        "Purchase",
        "--order-table",
        "purchases",
        "--order-id-type",
        "uuid",
        "--table-name",
        "shop_payment_attempts",
        "--meta-table-name",
        "shop_payment_meta",
        "--skip-foreign-key",
        "--force",
        "--out-dir",
        "./backend",
      ]);
      assert.equal(parsed.partial.orm, orm);
      assert.equal(parsed.partial.dialect, dialect);
      assert.equal(parsed.partial.orderModel, "Purchase");
      assert.equal(parsed.partial.orderTable, "purchases");
      assert.equal(parsed.partial.orderIdType, "uuid");
      assert.equal(parsed.partial.tableName, "shop_payment_attempts");
      assert.equal(parsed.partial.metaTableName, "shop_payment_meta");
      assert.equal(parsed.partial.skipForeignKey, true);
      assert.equal(parsed.partial.force, true);
      assert.equal(parsed.partial.outDir, "./backend");
    }
  }
});

test("each ORM emits its schema/migration files plus the wiring guide", () => {
  // Prisma's schema language cannot express the CHECK constraints or the seed
  // row, so it alone carries a raw-SQL companion file.
  const extraPaths = { prisma: ["prisma/openreceive-constraints.sql"] };
  for (const orm of OPENRECEIVE_ORMS) {
    for (const dialect of OPENRECEIVE_DIALECTS) {
      const files = renderFor(orm, dialect);
      assert.deepEqual(
        files.map((file) => file.path).sort(),
        [SCHEMA_PATHS[orm], ...(extraPaths[orm] ?? []), "OPENRECEIVE_PAYMENTS.md"].sort(),
        `${orm}/${dialect} emitted an unexpected file set`,
      );
    }
  }
});

test("schema files carry every canonical column with unix-integer timestamps", () => {
  for (const orm of OPENRECEIVE_ORMS) {
    for (const dialect of OPENRECEIVE_DIALECTS) {
      const schema = schemaFile(renderFor(orm, dialect), orm).contents;
      assert.match(schema, /openreceive_payments/);
      for (const column of CANONICAL_COLUMNS) {
        assert.match(schema, column, `${orm}/${dialect} schema missing ${column}`);
      }
      assert.match(schema, /pending/, `${orm}/${dialect} schema missing status default`);
      assert.match(
        schema,
        /status.{0,40}created/is,
        `${orm}/${dialect} schema missing (status, created_at) index`,
      );
      // The rate limiter counts on (client_ip, inserted_at) — an immutable
      // local-clock stamp. A template that drops the column or index silently
      // breaks DB-backed rate limiting.
      assert.match(
        schema,
        /client_?[iI]p.{0,40}inserted/is,
        `${orm}/${dialect} schema missing (client_ip, inserted_at) index`,
      );
      // Timestamps are unix-seconds integers, never Date/datetime columns.
      assert.doesNotMatch(
        schema,
        /DateTime|DataTypes\.DATE\b|mode:\s*"timestamp"|table\.timestamp\(|timestamptz|\bdatetime\b|useTz|@updatedAt/i,
        `${orm}/${dialect} schema must not use datetime columns`,
      );
    }
  }
});

test("scaffold DDL matches the repository's canonical schema, per dialect", () => {
  // The scaffold and @openreceive/http both render the shared canonical DDL
  // from @openreceive/core; this pins the two entry points to each other.
  const normalize = (sql) =>
    sql
      .replaceAll(";", "\n")
      .split("\n")
      .map((line) => line.trim().replace(/,$/, ""))
      .filter((line) => line !== "")
      .join("\n");
  for (const dialect of OPENRECEIVE_DIALECTS) {
    const scaffold = canonicalPaymentsDdlStatements({
      orm: "typeorm",
      dialect,
      orderModel: "Order",
      orderTable: "orders",
      orderIdType: "string",
      tableName: "openreceive_payments",
      metaTableName: "openreceive_meta",
      skipForeignKey: true,
      outDir: ".",
      force: false,
    }).join("\n");
    assert.equal(
      normalize(scaffold),
      normalize(openReceivePaymentsSchemaSql(dialect)),
      `${dialect} scaffold DDL drifted from openReceivePaymentsSchemaSql`,
    );
  }
});

test("raw-DDL migrations embed every canonical statement verbatim", () => {
  for (const orm of ["typeorm", "sequelize", "knex"]) {
    for (const dialect of OPENRECEIVE_DIALECTS) {
      const options = finalizeScaffoldOptions({
        orm,
        dialect,
        force: false,
        skipForeignKey: false,
        outDir: ".",
      });
      const schema = schemaFile(renderScaffoldPaymentsFiles(options), orm).contents;
      for (const statement of canonicalPaymentsDdlStatements(options)) {
        assert.ok(
          schema.includes(statement),
          `${orm}/${dialect} migration missing canonical statement: ${statement.split("\n")[0]}`,
        );
      }
    }
  }
});

test("every ORM emits both CHECK constraints and the schema_version seed row", () => {
  for (const orm of OPENRECEIVE_ORMS) {
    for (const dialect of OPENRECEIVE_DIALECTS) {
      const files = renderFor(orm, dialect);
      const emitted = files
        .filter((file) => file.path !== "OPENRECEIVE_PAYMENTS.md")
        .map((file) => file.contents)
        .join("\n");
      const guide = guideFile(files).contents;
      assert.match(
        emitted,
        /status IN \('pending', 'settled', 'expired', 'failed', 'attention'\)/,
        `${orm}/${dialect} missing the status CHECK`,
      );
      assert.match(
        emitted,
        dialect === "postgres"
          ? /payment_hash ~ '\^\[0-9a-f\]\{64\}\$'/
          : /length\(payment_hash\) = 64 AND payment_hash NOT GLOB '\*\[\^0-9a-f\]\*'/,
        `${orm}/${dialect} missing the payment_hash CHECK`,
      );
      // The seed row is what lets the repository's newer-schema refusal probe
      // engage. Drizzle's schema DSL cannot express it, so its wiring guide
      // carries it as a custom migration instead.
      const seed =
        dialect === "postgres"
          ? /INSERT INTO \w+ \(key, value, rev\) VALUES \('schema_version', '1', 0\) ON CONFLICT \(key\) DO NOTHING/
          : /INSERT OR IGNORE INTO \w+ \(key, value, rev\) VALUES \('schema_version', '1', 0\)/;
      assert.match(
        orm === "drizzle" ? guide : emitted,
        seed,
        `${orm}/${dialect} missing the schema_version seed row`,
      );
    }
  }
});

test("custom table names thread through every emitter", () => {
  for (const orm of OPENRECEIVE_ORMS) {
    const files = renderFor(orm, "postgres", {
      tableName: "shop_payment_attempts",
      metaTableName: "shop_payment_meta",
    });
    const schema = schemaFile(files, orm).contents;
    assert.match(schema, /shop_payment_attempts/, `${orm} schema ignores --table-name`);
    assert.match(schema, /shop_payment_meta/, `${orm} schema ignores --meta-table-name`);
    assert.doesNotMatch(
      schema,
      /\bopenreceive_payments\b|\bopenreceive_meta\b/,
      `${orm} schema still references the default table names`,
    );
    assert.match(guideFile(files).contents, /shop_payment_attempts/);
  }
});

test("no repository, settlement, or locking logic is emitted", () => {
  for (const orm of OPENRECEIVE_ORMS) {
    for (const dialect of OPENRECEIVE_DIALECTS) {
      const files = renderFor(orm, dialect);
      const joined = files.map((file) => `${file.path}\n${file.contents}`).join("\n");
      assert.doesNotMatch(
        joined,
        /commitAttempt|markPaidOnce|markOpenReceivePaidOnce|listUnsettledAttempts|listReconcilableAttempts|OpenReceiveHostRepository|payments-repository|host\.stub|OpenReceiveAttemptConflict|onFirstSettlement|liveAttemptCommitDecision|openReceivePaymentInsert/,
        `${orm}/${dialect} must not emit repository/settlement logic`,
      );
      assert.doesNotMatch(
        joined,
        /FOR UPDATE|for update|pessimistic_write|\.forUpdate\(/,
        `${orm}/${dialect} must not emit locking code`,
      );
    }
  }
});

test("wiring guide shows the library host wiring and the optional worker", () => {
  for (const orm of OPENRECEIVE_ORMS) {
    for (const dialect of OPENRECEIVE_DIALECTS) {
      const guide = guideFile(renderFor(orm, dialect)).contents;
      assert.match(guide, /import \{ createOpenReceiveHost \} from "@openreceive\/http";/);
      assert.match(guide, /createOpenReceiveHost\(\{ db, loadOrder, amountForOrder, onPaid \}\)/);
      // Default settlement is opportunistic (no boot-time loop); the worker is
      // an optional separate process wired by a host script.
      assert.match(guide, /opportunisticReconcile/);
      assert.match(guide, /startOpenReceiveNotificationWorker\(\{ service, host \}\)/);
      assert.doesNotMatch(guide, /startOpenReceiveReconciler/);
      assert.match(guide, /unix-seconds integers/);
      assert.match(guide, /status_reason/);
      assert.match(guide, /openreceive_meta/);
    }
  }
});

test("wiring guide gives per-ORM db guidance and adapter snippets", () => {
  const prismaPg = guideFile(renderFor("prisma", "postgres")).contents;
  assert.match(prismaPg, /\$transaction/);
  assert.match(prismaPg, /\$queryRawUnsafe/);
  assert.match(prismaPg, /dialect: "postgres"/);
  assert.match(prismaPg, /verbatim/);
  assert.match(prismaPg, /plain objects/);
  // The library renders its own statements per dialect, so no recipe may
  // renumber placeholders — doing so would corrupt host SQL.
  assert.doesNotMatch(prismaPg, /numbered\(/);

  const prismaSqlite = guideFile(renderFor("prisma", "sqlite")).contents;
  assert.match(prismaSqlite, /dialect: "sqlite"/);
  assert.doesNotMatch(prismaSqlite, /numbered\(/);

  const knexGuide = guideFile(renderFor("knex", "postgres")).contents;
  assert.match(knexGuide, /knex\.transaction/);
  assert.match(knexGuide, /\.raw\(/);
  assert.match(knexGuide, /verbatim/);

  const typeormGuide = guideFile(renderFor("typeorm", "postgres")).contents;
  assert.match(typeormGuide, /dataSource\.transaction/);
  assert.match(typeormGuide, /queryOn\(manager\)/);

  const drizzlePg = guideFile(renderFor("drizzle", "postgres")).contents;
  assert.match(drizzlePg, /underlying driver handle/);
  assert.match(drizzlePg, /db: pool/);

  const drizzleSqlite = guideFile(renderFor("drizzle", "sqlite")).contents;
  assert.match(drizzleSqlite, /db: sqlite/);

  const sequelizePg = guideFile(renderFor("sequelize", "postgres")).contents;
  assert.match(sequelizePg, /new Pool\(/);

  const sequelizeSqlite = guideFile(renderFor("sequelize", "sqlite")).contents;
  assert.match(sequelizeSqlite, /DatabaseSync|better-sqlite3/);
});

test("sqlite schemas use sqlite constructs", () => {
  const drizzle = schemaFile(renderFor("drizzle", "sqlite"), "drizzle").contents;
  assert.match(drizzle, /drizzle-orm\/sqlite-core/);
  assert.doesNotMatch(drizzle, /drizzle-orm\/pg-core|jsonb\(/);

  const typeorm = schemaFile(renderFor("typeorm", "sqlite"), "typeorm").contents;
  assert.match(typeorm, /INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.doesNotMatch(typeorm, /GENERATED ALWAYS AS IDENTITY/);

  const typeormPg = schemaFile(renderFor("typeorm", "postgres"), "typeorm").contents;
  assert.match(typeormPg, /GENERATED ALWAYS AS IDENTITY/);
  assert.match(typeormPg, /paid_at BIGINT/);

  const prisma = schemaFile(renderFor("prisma", "sqlite"), "prisma").contents;
  assert.match(prisma, /Int\s+@id @default\(autoincrement\(\)\)/);
});

test("order-id typing and foreign keys follow the flags", () => {
  const prismaUuid = schemaFile(
    renderFor("prisma", "postgres", { orderIdType: "uuid" }),
    "prisma",
  ).contents;
  assert.match(prismaUuid, /@db\.Uuid/);
  assert.match(prismaUuid, /@relation\(fields: \[orderId\], references: \[id\]/);

  const knexUuid = schemaFile(
    renderFor("knex", "postgres", { orderIdType: "uuid" }),
    "knex",
  ).contents;
  assert.match(knexUuid, /order_id UUID NOT NULL REFERENCES orders \(id\)/);

  const typeormUuid = schemaFile(
    renderFor("typeorm", "postgres", { orderIdType: "uuid" }),
    "typeorm",
  ).contents;
  assert.match(typeormUuid, /order_id UUID NOT NULL REFERENCES orders \(id\)/);

  for (const orm of OPENRECEIVE_ORMS) {
    const withFk = schemaFile(renderFor(orm, "postgres"), orm).contents;
    assert.match(withFk, /references|REFERENCES|@relation/i, `${orm} default should emit a FK`);
    const withoutFk = schemaFile(
      renderFor(orm, "postgres", { skipForeignKey: true }),
      orm,
    ).contents;
    assert.doesNotMatch(
      withoutFk,
      /references|REFERENCES|@relation/i,
      `${orm} --skip-foreign-key should drop the FK`,
    );
  }
});

test("scaffold logs plan details including dialect", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openreceive-scaffold-"));
  try {
    const output = [];
    const code = await runOpenReceiveCli({
      argv: ["scaffold", "payments", "--orm", "knex", "--dialect", "sqlite"],
      cwd: dir,
      stdout: { write: (message) => output.push(message) },
      stderr: { write: () => {} },
      isTTY: false,
    });
    assert.equal(code, 0);
    const text = output.join("");
    assert.match(text, /orm:\s+knex/);
    assert.match(text, /dialect:\s+sqlite/);
    assert.match(text, /Writing files/);
    assert.match(text, /wrote /);
    assert.match(text, /Done\./);
    assert.match(text, /single-writer/);
    assert.match(text, /createOpenReceiveHost\(\{ db, loadOrder, amountForOrder, onPaid \}\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interactive wizard fills missing options and writes files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openreceive-scaffold-"));
  const answers = ["prisma", "sqlite", "Order", "orders", "string", "y", "."];
  try {
    const output = [];
    const code = await runOpenReceiveCli({
      argv: ["scaffold", "payments", "--interactive"],
      cwd: dir,
      stdout: { write: (message) => output.push(message) },
      stderr: { write: () => {} },
      isTTY: true,
      prompt: async () => answers.shift() ?? "",
    });
    assert.equal(code, 0);
    const schema = await readFile(path.join(dir, "prisma/schema.openreceive.prisma"), "utf8");
    assert.match(schema, /model OpenReceivePayment/);
    assert.match(schema, /@@map\("openreceive_payments"\)/);
    assert.match(schema, /Dialect: sqlite/);
    const guide = await readFile(path.join(dir, "OPENRECEIVE_PAYMENTS.md"), "utf8");
    assert.match(guide, /createOpenReceiveHost\(\{ db, loadOrder, amountForOrder, onPaid \}\)/);
    assert.match(output.join(""), /wrote /);
    assert.match(output.join(""), /dialect:\s+sqlite/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scaffold refuses to overwrite without --force", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openreceive-scaffold-"));
  try {
    const first = await runOpenReceiveCli({
      argv: ["scaffold", "payments", "--orm", "knex"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      isTTY: false,
    });
    assert.equal(first, 0);

    const errors = [];
    const second = await runOpenReceiveCli({
      argv: ["scaffold", "payments", "--orm", "knex"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: (message) => errors.push(message) },
      isTTY: false,
    });
    assert.equal(second, 1);
    assert.match(errors.join(""), /--force/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
