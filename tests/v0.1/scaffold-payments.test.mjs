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
import { OPENRECEIVE_ORMS } from "../../packages/js/node/src/scaffold/types.ts";

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

test("parseScaffoldPaymentsArgv accepts all five ORMs and order flags", () => {
  for (const orm of OPENRECEIVE_ORMS) {
    const parsed = parseScaffoldPaymentsArgv([
      "--orm",
      orm,
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
    assert.equal(parsed.partial.orderModel, "Purchase");
    assert.equal(parsed.partial.orderTable, "purchases");
    assert.equal(parsed.partial.orderIdType, "uuid");
    assert.equal(parsed.partial.skipForeignKey, true);
    assert.equal(parsed.partial.force, true);
    assert.equal(parsed.partial.outDir, "./backend");
  }
});

test("each ORM scaffold emits schema, repository, settlement, and hooks", () => {
  for (const orm of OPENRECEIVE_ORMS) {
    const options = finalizeScaffoldOptions({
      orm,
      force: false,
      skipForeignKey: false,
      outDir: ".",
    });
    const files = renderScaffoldPaymentsFiles(options);
    const joined = files.map((file) => `${file.path}\n${file.contents}`).join("\n");

    assert.ok(files.some((file) => file.path.endsWith("payments-repository.ts")));
    assert.ok(files.some((file) => file.path.endsWith("mark-paid-once.ts")));
    assert.ok(files.some((file) => file.path.endsWith("hooks.stub.ts")));
    assert.ok(files.some((file) => file.path === "OPENRECEIVE_PAYMENTS.md"));
    assert.match(joined, /openreceive_payments/);
    assert.match(joined, /payment_hash|paymentHash/);
    assert.match(joined, /swap_data|swapData/);
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

test("interactive wizard fills missing options and writes files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openreceive-scaffold-"));
  const answers = [
    "prisma",
    "Order",
    "orders",
    "string",
    "y",
    ".",
  ];
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
    assert.match(output.join(""), /wrote /);
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
