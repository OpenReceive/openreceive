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
} from "../../packages/js/node/src/cli.ts";
import {
  OPENRECEIVE_DIALECTS,
  OPENRECEIVE_ORMS,
} from "../../packages/js/node/src/scaffold/types.ts";

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

test("scaffold payments help documents --dialect", async () => {
  const lines = [];
  const code = await runOpenReceiveCli({
    argv: ["scaffold", "payments", "--help"],
    cwd: process.cwd(),
    stdout: { write: (message) => lines.push(message) },
    stderr: { write: () => {} },
    isTTY: false,
  });
  assert.equal(code, 0);
  assert.match(lines.join(""), /--dialect/);
  assert.match(lines.join(""), /postgres \| sqlite/);
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
      assert.equal(parsed.partial.skipForeignKey, true);
      assert.equal(parsed.partial.force, true);
      assert.equal(parsed.partial.outDir, "./backend");
    }
  }
});

test("each ORM postgres scaffold emits schema, repository, settlement, and FOR UPDATE locks", () => {
  for (const orm of OPENRECEIVE_ORMS) {
    const options = finalizeScaffoldOptions({
      orm,
      dialect: "postgres",
      force: false,
      skipForeignKey: false,
      outDir: ".",
    });
    assert.equal(options.dialect, "postgres");
    const files = renderScaffoldPaymentsFiles(options);
    const joined = files.map((file) => `${file.path}\n${file.contents}`).join("\n");

    assert.ok(files.some((file) => file.path.endsWith("payments-repository.ts")));
    assert.ok(files.some((file) => file.path.endsWith("mark-paid-once.ts")));
    assert.ok(files.some((file) => file.path.endsWith("host.stub.ts")));
    assert.ok(files.some((file) => file.path === "OPENRECEIVE_PAYMENTS.md"));
    assert.match(joined, /openreceive_payments/);
    assert.match(joined, /checkout_data|checkoutData/);
    assert.match(joined, /payment_hash|paymentHash/);
    assert.match(joined, /swap_data|swapData/);
    assert.match(joined, /onFirstSettlement/);
    assert.match(joined, /createOpenReceiveHost/);
    assert.match(joined, /FOR UPDATE|for update|pessimistic_write|forUpdate/);
    assert.doesNotMatch(
      joined,
      /@@unique\(\[orderId\]\)|uniqueIndex\("[^"]*order[^"]*"\)\.on\(table\.orderId\)\s*[,)]/,
    );
    assert.match(
      joined,
      /@unique|unique:\s*true|uniqueIndex\("openreceive_payments_hash|\.unique\(\)/,
    );
  }
});

test("each ORM sqlite scaffold avoids FOR UPDATE locks in repository code", () => {
  for (const orm of OPENRECEIVE_ORMS) {
    const options = finalizeScaffoldOptions({
      orm,
      dialect: "sqlite",
      force: false,
      skipForeignKey: false,
      outDir: ".",
    });
    const files = renderScaffoldPaymentsFiles(options);
    const code = files
      .filter(
        (file) =>
          file.path.endsWith(".ts") || file.path.endsWith(".js") || file.path.endsWith(".prisma"),
      )
      .map((file) => file.contents)
      .join("\n");
    const docs = files.find((file) => file.path === "OPENRECEIVE_PAYMENTS.md")?.contents ?? "";

    assert.match(code, /openreceive_payments/);
    assert.match(code, /checkout_data|checkoutData/);
    assert.match(docs, /SQLite|sqlite|single-writer/);
    assert.doesNotMatch(code, /\bFOR UPDATE\b|\bfor update\b|pessimistic_write|\.forUpdate\(/);
    if (orm === "drizzle") {
      assert.match(code, /drizzle-orm\/sqlite-core/);
      assert.doesNotMatch(code, /drizzle-orm\/pg-core|jsonb\(/);
    }
    if (orm === "typeorm") {
      assert.match(code, /simple-json|datetime/);
      assert.doesNotMatch(code, /jsonb|timestamptz/);
    }
    if (orm === "knex") {
      assert.match(code, /useTz: false/);
    }
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
    assert.match(text, /single-writer|wipe the SQLite file/);
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
